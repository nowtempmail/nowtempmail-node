/**
 * The CLI against a real listening socket.
 *
 * `run()` returns an exit code instead of calling `process.exit()`, which is what
 * lets these tests drive the whole binary — argv parsing, credential resolution,
 * the client, the renderers, the error mapping — with an injected writer and no
 * subprocess. `dist/` does not have to exist. The lead's `e2e-smoke.test.ts`
 * covers the spawned-binary path once it does.
 *
 * The mock API is a real HTTP server, so the traffic here is genuine: metering
 * headers, RFC 9457 problem bodies, quota that creation spends and deletion never
 * refunds.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT, NO_API_KEY_MESSAGE } from "../../src/cli/errors.js";
import { run, type Env } from "../../src/cli/run.js";
import { CSI } from "../../src/cli/style.js";
import { VERSION } from "../../src/http.js";
import { MOCK_KEY, createMockApi, startMockServer, type MockApi } from "../helpers/mock-api.js";

/** The second half of the mock key. Must never be printed, in any form. */
const SECRET_HALF = "4nT8wKmZqRv2sYbXdF6hJ3pLcN9gTuA";

let api: MockApi;
let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  api = createMockApi({ now: () => Date.now() });
  server = await startMockServer(api);
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  api.reset();
});

interface CliOptions {
  env?: Env;
  signal?: AbortSignal;
  baseUrl?: string;
}

/** Start a command and expose its streams while it is still running. */
function cli(argv: string[], options: CliOptions = {}) {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const promise = run({
    argv: [...argv, "--base-url", options.baseUrl ?? server.url],
    env: {
      NTM_API_KEY: MOCK_KEY,
      NO_COLOR: "1",
      // Stop the tests waiting out the 2s poll floor. Not a documented flag.
      NTM_POLL_INTERVAL_MS: "25",
      ...options.env,
    },
    out: (text) => outChunks.push(text),
    err: (text) => errChunks.push(text),
    isTty: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    promise,
    stdout: () => outChunks.join(""),
    stderr: () => errChunks.join(""),
    all: () => outChunks.join("") + errChunks.join(""),
  };
}

async function runCli(argv: string[], options: CliOptions = {}) {
  const handle = cli(argv, options);
  const code = await handle.promise;
  return {
    code,
    stdout: handle.stdout(),
    stderr: handle.stderr(),
    all: () => handle.all(),
  };
}

async function createMailbox(): Promise<string> {
  const result = await runCli(["new"]);
  expect(result.code).toBe(EXIT.OK);
  return result.stdout.trim();
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/* -------------------------------------------------------------------------- */

describe("new", () => {
  it("prints the address on stdout and the human line on stderr", async () => {
    const { code, stdout, stderr } = await runCli(["new"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toMatch(/^[a-z0-9]+@allogebra\.com\n$/);
    expect(stderr).toContain("expires in 24h");
    expect(stderr).toContain("mailboxes left today");
    // Piped output carries no escape codes, ever.
    expect(stdout + stderr).not.toContain(CSI);
  });

  it("honours --domain and --ttl", async () => {
    const { code, stdout, stderr } = await runCli([
      "new",
      "--domain",
      "mailtemp.dev",
      "--ttl",
      "900",
    ]);
    expect(code).toBe(EXIT.OK);
    expect(stdout.trim()).toMatch(/@mailtemp\.dev$/);
    expect(stderr).toContain("expires in 15m");
    expect(api.state.mailboxes.get(stdout.trim())?.ttlSeconds).toBe(900);
  });

  it("shapes --json as one document with no secret in it", async () => {
    const { code, stdout } = await runCli(["new", "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.address).toMatch(/@allogebra\.com$/);
    expect(parsed.ttlSeconds).toBe(86_400);
    expect(parsed.confirmed).toBe(true);
    expect(stdout).not.toContain("ntm_live_");
  });

  it("reports a plan gate against the flag the user typed", async () => {
    const { code, stderr } = await runCli(["new", "--address", "my-signup-test"]);
    expect(code).toBe(EXIT.FAIL);
    expect(stderr).toContain("`--address` needs a paid plan");
    expect(stderr).toContain("request req_");
  });

  it("exits 1 with the numbers when the daily quota is spent", async () => {
    const smallApi = createMockApi({ plan: { mailboxesPerDay: 1 }, now: () => Date.now() });
    const smallServer = await startMockServer(smallApi);
    try {
      const first = await runCli(["new"], { baseUrl: smallServer.url });
      expect(first.code).toBe(EXIT.OK);
      const second = await runCli(["new"], { baseUrl: smallServer.url });
      expect(second.code).toBe(EXIT.FAIL);
      expect(second.stderr).toMatch(/daily mailbox quota reached \(1\/1\)\. Resets 00:00 UTC in/);
      expect(second.stdout).toBe("");
    } finally {
      await smallServer.close();
    }
  });

  it("can create and wait for a code in one shot", async () => {
    const handle = cli(["new", "--wait-code", "--wait", "5"]);
    await waitFor(() => handle.stdout().includes("@allogebra.com"), "the address");
    const address = handle.stdout().trim();
    api.deliver(address, { verificationCodes: ["135790"] });
    const code = await handle.promise;
    expect(code).toBe(EXIT.OK);
    // Address first, then the code, both on stdout and nothing else.
    expect(handle.stdout()).toBe(`${address}\n135790\n`);
  });
});

describe("code", () => {
  it("prints only the code on stdout", async () => {
    const address = await createMailbox();
    api.deliver(address, { verificationCodes: ["991234"] });

    const { code, stdout, stderr } = await runCli(["code", address, "--wait", "5"]);
    expect(code).toBe(EXIT.OK);
    // Pipeable: `CODE=$(nowtempmail code …)` gets the code and nothing else.
    expect(stdout).toBe("991234\n");
    expect(stderr).toContain("waiting up to 5s");
  });

  it("filters on --from and --subject", async () => {
    const address = await createMailbox();
    api.deliver(address, { from: "Stripe <hi@stripe.com>", verificationCodes: ["111111"] });
    api.deliver(address, {
      from: "GitHub <noreply@github.com>",
      subject: "[GitHub] verify",
      verificationCodes: ["222222"],
    });

    const byFrom = await runCli(["code", address, "--from", "github", "--wait", "5"]);
    expect(byFrom.stdout).toBe("222222\n");

    const bySubject = await runCli(["code", address, "--subject", "github", "--wait", "5"]);
    expect(bySubject.stdout).toBe("222222\n");
  });

  it("exits 4 when the wait elapses, and says what it saw", async () => {
    const address = await createMailbox();
    api.deliver(address, { verificationCodes: [] });
    api.deliver(address, { verificationCodes: [] });

    const { code, stdout, stderr } = await runCli(["code", address, "--wait", "1"]);
    expect(code).toBe(EXIT.TIMEOUT);
    expect(stderr).toContain("2 messages arrived, none carried a code");
    // Nothing on stdout means a shell substitution yields an empty string, not junk.
    expect(stdout).toBe("");
  });

  it("distinguishes an empty inbox from mail without a code", async () => {
    const address = await createMailbox();
    const { code, stderr } = await runCli(["code", address, "--timeout", "1"]);
    expect(code).toBe(EXIT.TIMEOUT);
    expect(stderr).toContain("no messages arrived");
  });

  it("fails fast on an address that does not exist", async () => {
    const { code, stderr } = await runCli(["code", "nobody@allogebra.com", "--wait", "30"]);
    expect(code).toBe(EXIT.FAIL);
    expect(stderr).toContain("no mailbox nobody@allogebra.com");
  });

  it("carries the code and the address under --json", async () => {
    const address = await createMailbox();
    api.deliver(address, { verificationCodes: ["424242"] });
    const { code, stdout } = await runCli(["code", address, "--json", "--wait", "5"]);
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toEqual({ address, code: "424242" });
  });
});

describe("ls", () => {
  it("renders a table on stdout, newest first", async () => {
    const address = await createMailbox();
    api.deliver(address, { subject: "older", verificationCodes: ["111111"] });
    api.deliver(address, { subject: "newer", verificationCodes: ["222222"] });

    const { code, stdout } = await runCli(["ls", address]);
    expect(code).toBe(EXIT.OK);
    const lines = stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("RECEIVED");
    expect(lines[1]).toContain("newer");
    expect(lines[2]).toContain("older");
    expect(lines[1]).toContain("222222");
  });

  it("keeps stdout empty when there is no mail", async () => {
    const address = await createMailbox();
    const { code, stdout, stderr } = await runCli(["ls", address]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toBe("");
    expect(stderr).toContain("no messages");
  });

  it("respects --limit and says when there is more", async () => {
    const address = await createMailbox();
    api.deliver(address, { subject: "one" });
    api.deliver(address, { subject: "two" });
    const { stdout, stderr } = await runCli(["ls", address, "--limit", "1"]);
    expect(stdout.trimEnd().split("\n")).toHaveLength(2); // header + one row
    expect(stderr).toContain("more messages beyond --limit 1");
  });

  it("emits a message array under --json", async () => {
    const address = await createMailbox();
    api.deliver(address, { verificationCodes: ["313131"] });
    const { stdout } = await runCli(["ls", address, "--json"]);
    const parsed = JSON.parse(stdout) as {
      address: string;
      hasMore: boolean;
      messages: Array<{ verificationCodes: string[]; receivedAt: string }>;
    };
    expect(parsed.address).toBe(address);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.messages[0]?.verificationCodes).toEqual(["313131"]);
    expect(parsed.messages[0]?.receivedAt).toMatch(/Z$/);
  });
});

describe("rm", () => {
  it("reports how many messages went with the mailbox", async () => {
    const address = await createMailbox();
    api.deliver(address);
    api.deliver(address);

    const { code, stdout, stderr } = await runCli(["rm", address]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toBe(`${address}\n`);
    expect(stderr).toContain("2 messages went with it");
    expect(api.state.mailboxes.has(address)).toBe(false);
    // Quota is spent even though the mailbox is gone.
    expect(api.state.mailboxesToday).toBe(1);
  });

  it("exits 1 on a mailbox that is already gone", async () => {
    const { code, stderr } = await runCli(["rm", "ghost@allogebra.com"]);
    expect(code).toBe(EXIT.FAIL);
    expect(stderr).toContain("no mailbox ghost@allogebra.com");
  });
});

describe("whoami", () => {
  it("prints the key id and never the key", async () => {
    const { code, stdout, all } = await runCli(["whoami"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("k7Rm2xQp9Ldv");
    expect(stdout).toContain("Free");
    expect(all).not.toContain(MOCK_KEY);
    expect(all).not.toContain(SECRET_HALF);
  });

  it("is reachable as `me`, and stays secret-free under --json", async () => {
    const { code, stdout, all } = await runCli(["me", "--json"]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(stdout) as { keyId: string; plan: { label: string } };
    expect(parsed.keyId).toBe("k7Rm2xQp9Ldv");
    expect(parsed.plan.label).toBe("Free");
    expect(all).not.toContain(MOCK_KEY);
    expect(all).not.toContain(SECRET_HALF);
    expect(all).not.toContain("ntm_live_");
  });
});

describe("domains", () => {
  it("marks the domain the rotation would pick", async () => {
    const { code, stdout } = await runCli(["domains"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toBe("allogebra.com  (default)\nmailtemp.dev\n");
  });

  it("lists them as data under --json", async () => {
    const { stdout } = await runCli(["domains", "--json"]);
    expect(JSON.parse(stdout)).toEqual({
      domains: [
        { domain: "allogebra.com", default: true },
        { domain: "mailtemp.dev", default: false },
      ],
    });
  });
});

describe("tail", () => {
  it("prints the derived poll interval before anything else", async () => {
    const address = await createMailbox();
    const controller = new AbortController();
    // No override: the interval is derived from the key's 30/min budget.
    const handle = cli(["tail", address], {
      signal: controller.signal,
      env: { NTM_POLL_INTERVAL_MS: "" },
    });
    await waitFor(() => handle.stderr().includes("watching"), "the watching line");
    expect(handle.stderr()).toContain("watching · polling every 2.0s · ⌃C to stop");
    controller.abort();
    expect(await handle.promise).toBe(EXIT.OK);
  });

  it("prints new mail as it arrives and stops cleanly on ⌃C", async () => {
    const address = await createMailbox();
    api.deliver(address, { subject: "already here", verificationCodes: ["111111"] });

    const controller = new AbortController();
    const handle = cli(["tail", address], { signal: controller.signal });
    await waitFor(() => handle.stderr().includes("watching"), "the watching line");
    api.deliver(address, { subject: "brand new", verificationCodes: ["222222"] });
    await waitFor(() => handle.stdout().includes("222222"), "the new message");

    controller.abort();
    const code = await handle.promise;
    expect(code).toBe(EXIT.OK);
    expect(handle.stdout()).toContain("brand new");
    // Backlog is not replayed: `ls` is the command for history.
    expect(handle.stdout()).not.toContain("111111");
    expect(handle.stderr()).toContain("stopped");
  });

  it("emits one JSON object per line under --json", async () => {
    const address = await createMailbox();
    const controller = new AbortController();
    const handle = cli(["tail", address, "--json"], { signal: controller.signal });
    await waitFor(() => handle.stderr().includes("watching"), "the watching line");
    api.deliver(address, { verificationCodes: ["777777"] });
    api.deliver(address, { verificationCodes: ["888888"] });
    await waitFor(() => handle.stdout().includes("888888"), "both messages");
    controller.abort();
    expect(await handle.promise).toBe(EXIT.OK);

    const lines = handle.stdout().trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { address: string; id: string };
      expect(parsed.address).toBe(address);
      expect(parsed.id).toMatch(/^msg_/);
    }
  });

  it("exits 1 on a mailbox that does not exist", async () => {
    const { code, stderr } = await runCli(["tail", "nobody@allogebra.com"]);
    expect(code).toBe(EXIT.FAIL);
    expect(stderr).toContain("no mailbox nobody@allogebra.com");
  });
});

describe("credentials", () => {
  it("exits 2 with somewhere to go when NTM_API_KEY is unset", async () => {
    const { code, stdout, stderr } = await runCli(["new"], { env: { NTM_API_KEY: "" } });
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain(NO_API_KEY_MESSAGE);
    expect(stdout).toBe("");
    // No mailbox was created, so no quota was spent guessing.
    expect(api.state.mailboxesToday).toBe(0);
  });

  it("exits 2 when the key is rejected, and does not echo it", async () => {
    const wrongKey = "ntm_live_wrongKeyId01_wrongSecretHalfThatIsAlsoLongEnough";
    const { code, stderr, all } = await runCli(["whoami"], { env: { NTM_API_KEY: wrongKey } });
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("the API key was rejected");
    expect(stderr).toContain("developers/keys");
    expect(all).not.toContain(wrongKey);
  });

  it("reads the base URL from NTM_BASE_URL as well as the flag", async () => {
    // The flag is appended by the harness, so drop it: argv without --base-url.
    const outChunks: string[] = [];
    const code = await run({
      argv: ["domains"],
      env: { NTM_API_KEY: MOCK_KEY, NTM_BASE_URL: server.url, NO_COLOR: "1" },
      out: (text) => outChunks.push(text),
      err: () => {},
      isTty: false,
    });
    expect(code).toBe(EXIT.OK);
    expect(outChunks.join("")).toContain("allogebra.com");
  });

  it("exits 2 on a base URL that would put the key on the wire in clear text", async () => {
    const { code, stderr } = await runCli(["whoami"], { baseUrl: "http://example.com" });
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("https");
  });

  it("writes no config file: there is no login command", async () => {
    const { code, stderr } = await runCli(["login"]);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("unknown command `login`");
  });
});

describe("help, version and usage errors", () => {
  it("prints usage on --help and on no arguments at all", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(EXIT.OK);
    expect(help.stdout).toContain("nowtempmail <command> [flags]");
    expect(help.stdout).toContain("NTM_API_KEY");

    // No key needed to ask for help.
    const bare = await run({
      argv: [],
      env: {},
      out: () => {},
      err: () => {},
      isTty: false,
    });
    expect(bare).toBe(EXIT.OK);
  });

  it("prints per-command help", async () => {
    const { code, stdout } = await runCli(["code", "--help"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toContain("nowtempmail code <address>");
    expect(stdout).toContain("--wait, --timeout <seconds>");
  });

  it("prints the version", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(EXIT.OK);
    expect(stdout).toBe(`${VERSION}\n`);
  });

  it("exits 2 on an unknown flag, and shows the command's usage", async () => {
    const { code, stdout, stderr } = await runCli(["ls", "a@allogebra.com", "--nope"]);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("unknown flag `--nope`");
    expect(stderr).toContain("usage: nowtempmail ls <address>");
    expect(stdout).toBe("");
  });

  it("exits 2 when a required address is missing", async () => {
    const { code, stderr } = await runCli(["code"]);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr).toContain("`<address>` is required");
  });
});

describe("colour", () => {
  it("emits ANSI on a TTY and none when NO_COLOR is set", async () => {
    const address = await createMailbox();
    api.deliver(address, { verificationCodes: ["565656"] });

    const coloured: string[] = [];
    await run({
      argv: ["ls", address, "--base-url", server.url],
      env: { NTM_API_KEY: MOCK_KEY },
      out: (text) => coloured.push(text),
      err: () => {},
      isTty: true,
    });
    expect(coloured.join("")).toContain(CSI);

    const suppressed = await runCli(["ls", address], { env: { NO_COLOR: "1" } });
    expect(suppressed.stdout).not.toContain(CSI);

    const byFlag: string[] = [];
    await run({
      argv: ["ls", address, "--no-color", "--base-url", server.url],
      env: { NTM_API_KEY: MOCK_KEY },
      out: (text) => byFlag.push(text),
      err: () => {},
      isTty: true,
    });
    expect(byFlag.join("")).not.toContain(CSI);
  });
});

describe("the key never reaches the terminal", () => {
  it("scrubs it even when a hostile sender puts it in a subject line", async () => {
    const address = await createMailbox();
    api.deliver(address, { subject: `your key is ${MOCK_KEY}`, verificationCodes: ["999999"] });

    const table = await runCli(["ls", address]);
    expect(table.all()).not.toContain(MOCK_KEY);
    expect(table.all()).not.toContain(SECRET_HALF);
    expect(table.stdout).toContain("[redacted]");
    // The table truncates the subject, so what reaches the writer is a *partial*
    // key. A partial key is still a leaked key, and it must go too.
    expect(table.all()).not.toContain("ntm_live_k7Rm2xQp9Ldv_4nT8");

    const json = await runCli(["ls", address, "--json"]);
    expect(json.all()).not.toContain(MOCK_KEY);
    expect(json.all()).not.toContain(SECRET_HALF);
  });

  it("keeps it out of every command's output", async () => {
    const address = await createMailbox();
    api.deliver(address, { verificationCodes: ["606060"] });
    for (const argv of [
      ["new"],
      ["whoami"],
      ["whoami", "--json"],
      ["domains"],
      ["ls", address],
      ["code", address, "--wait", "5"],
      ["rm", address],
      ["--help"],
      ["nonsense"],
    ]) {
      const result = await runCli(argv);
      expect(result.all(), `command ${argv.join(" ")} leaked the key`).not.toContain(MOCK_KEY);
      expect(result.all()).not.toContain(SECRET_HALF);
    }
  });
});
