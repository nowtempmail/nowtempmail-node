/**
 * `nowtempmail mcp` routing.
 *
 * The bug this covers shipped in 0.1.0: the README told MCP users to run
 * `npx -y nowtempmail-mcp@0.1.0`, which 404s — npx resolves a *package* name and
 * `nowtempmail-mcp` is only a bin inside the `nowtempmail` package. The fix is a
 * subcommand, and a subcommand that is intercepted before the CLI's own parser
 * runs, because the MCP server owns an entirely different flag set.
 *
 * Nothing here starts a server. The seam under test is the routing decision and
 * the argv that crosses it; the server itself is covered in
 * `test/integrations/mcp.test.ts` and `test/e2e-smoke.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import { parseArgv } from "../../src/cli/args.js";
import {
  MCP_INVOCATION,
  MCP_SUBCOMMAND,
  dispatchMcp,
  matchMcpSubcommand,
  type McpLoader,
} from "../../src/cli/mcp.js";
import { renderUsage } from "../../src/cli/help.js";
import { createPalette } from "../../src/cli/style.js";
import { runMcpBin } from "../../src/mcp/run.js";
import { VERSION } from "../../src/http.js";

/** A stand-in for `runMcpBin` that records what it was handed. */
function spyLoader(exitCode = 0) {
  const runMcpBin = vi.fn(async (_argv: readonly string[], _invokedAs?: string) => exitCode);
  const load: McpLoader = vi.fn(async () => ({ runMcpBin }));
  return { load: load as McpLoader & ReturnType<typeof vi.fn>, runMcpBin };
}

describe("matchMcpSubcommand", () => {
  it("claims `mcp` and returns everything after it", () => {
    expect(matchMcpSubcommand(["mcp"])).toEqual([]);
    expect(matchMcpSubcommand(["mcp", "--allow-body-read"])).toEqual(["--allow-body-read"]);
  });

  it("claims nothing else", () => {
    for (const argv of [[], ["new"], ["ls", "a@allogebra.com"], ["--help"], ["--json", "mcp"]]) {
      expect(matchMcpSubcommand(argv), argv.join(" ")).toBeUndefined();
    }
  });

  it("only looks at the first token, so an address called `mcp` is still an address", () => {
    expect(matchMcpSubcommand(["ls", "mcp"])).toBeUndefined();
    expect(matchMcpSubcommand(["code", "mcp@allogebra.com"])).toBeUndefined();
  });
});

describe("dispatchMcp", () => {
  it("dispatches `mcp` instead of letting it reach the CLI parser", async () => {
    // The parser has no `mcp` command and must not grow one: this is exactly the
    // failure users saw with `npx -y nowtempmail@0.1.0 mcp`.
    const parsed = parseArgv([MCP_SUBCOMMAND]);
    expect(parsed.kind).toBe("usage-error");
    expect(parsed.kind === "usage-error" && parsed.message).toContain("unknown command `mcp`");

    // Interception happens first, so that result is never reached.
    const { load, runMcpBin } = spyLoader();
    await expect(dispatchMcp([MCP_SUBCOMMAND], load)).resolves.toBe(0);
    expect(runMcpBin).toHaveBeenCalledTimes(1);
    expect(runMcpBin.mock.calls[0]?.[0]).toEqual([]);
  });

  it("passes the MCP server's own flags through untouched", async () => {
    const flags = [
      "--allow-body-read",
      "--max-mailboxes",
      "5",
      "--max-mailboxes=7",
      "--base-url",
      "http://localhost:8787",
      "--help",
      "-V",
      // Not a flag this CLI knows, and not this CLI's business: the MCP server
      // decides what is valid, including how it rejects.
      "--some-future-mcp-flag",
      "--",
      "trailing",
    ];
    const { load, runMcpBin } = spyLoader();

    await dispatchMcp([MCP_SUBCOMMAND, ...flags], load);

    expect(runMcpBin.mock.calls[0]?.[0]).toEqual(flags);
    // And it is told how it was invoked, so its usage text says `nowtempmail mcp`.
    expect(runMcpBin.mock.calls[0]?.[1]).toBe(MCP_INVOCATION);
    expect(MCP_INVOCATION).toBe("nowtempmail mcp");
  });

  it("returns the server's exit code verbatim", async () => {
    const { load } = spyLoader(2);
    await expect(dispatchMcp(["mcp", "--nope"], load)).resolves.toBe(2);
  });

  it("returns undefined for an ordinary command, and never loads the MCP module", async () => {
    const { load, runMcpBin } = spyLoader();
    await expect(dispatchMcp(["new", "--ttl", "900"], load)).resolves.toBeUndefined();
    await expect(dispatchMcp([], load)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(runMcpBin).not.toHaveBeenCalled();
  });
});

describe("runMcpBin with an explicit argv", () => {
  /** Capture stdout without letting it reach the reporter. */
  async function capture(argv: string[]): Promise<{ code: number; stdout: string }> {
    const chunks: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => (chunks.push(String(chunk)), true));
    try {
      const code = await runMcpBin(argv, MCP_INVOCATION);
      return { code, stdout: chunks.join("") };
    } finally {
      write.mockRestore();
    }
  }

  // Both of these resolve before the server needs a key or a transport, which is
  // what makes them safe to run in-process — and is also why an MCP client's
  // first smoke test can use them.
  it("prints the version and exits 0", async () => {
    const { code, stdout } = await capture(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toBe(`${VERSION}\n`);
  });

  it("prints help naming the invocation it was reached by", async () => {
    const { code, stdout } = await capture(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("nowtempmail mcp [options]");
    // The config snippet users copy must be the one that resolves on npm.
    expect(stdout).toContain(`"args": ["-y", "nowtempmail@${VERSION}", "mcp"]`);
    expect(stdout).toContain("${NTM_API_KEY}");
    expect(stdout).not.toContain('"args": ["-y", "nowtempmail-mcp"]');
    // And the direct bin is still documented, with the -p that npx needs.
    expect(stdout).toContain("npx -y -p nowtempmail");
  });

  it("rejects an unknown flag with exit 2 rather than starting a server", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runMcpBin(["--nope"], MCP_INVOCATION)).resolves.toBe(2);
      expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option --nope");
    } finally {
      err.mockRestore();
    }
  });
});

describe("discoverability", () => {
  it("lists mcp in the top-level help, since the binary answers to it", () => {
    const usage = renderUsage(createPalette(false), "0.1.1");
    expect(usage).toContain("mcp");
    expect(usage).toContain("nowtempmail mcp --help");
  });
});
