/**
 * The argv parser, on its own. No sockets, no process, no clock.
 *
 * The command surface is pinned here rather than only in the integration tests,
 * because a flag that quietly stops being recognised is the kind of regression
 * that reaches a user's CI job before it reaches anyone's screen.
 */

import { describe, expect, it } from "vitest";

import {
  COMMANDS,
  GLOBAL_FLAGS,
  findCommand,
  flagBoolean,
  flagInteger,
  flagString,
  parseArgv,
} from "../../src/cli/args.js";

function command(argv: string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== "command") {
    throw new Error(`expected a command, got ${parsed.kind}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function usageError(argv: string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== "usage-error") {
    throw new Error(`expected a usage error, got ${parsed.kind}`);
  }
  return parsed;
}

describe("the command surface", () => {
  it("is exactly the eight documented commands", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "new",
      "tail",
      "code",
      "ls",
      "rm",
      "whoami",
      "domains",
    ]);
  });

  it("has no login command, because the only credential is NTM_API_KEY", () => {
    expect(findCommand("login")).toBeUndefined();
    expect(findCommand("logout")).toBeUndefined();
    expect(findCommand("config")).toBeUndefined();
  });

  it("accepts the global flags on every command", () => {
    expect(Object.keys(GLOBAL_FLAGS)).toEqual(["base-url", "json", "no-color", "help"]);
    for (const spec of COMMANDS) {
      const parsed = command([
        spec.name,
        ...spec.args.map(() => "someone@allogebra.com"),
        "--json",
        "--no-color",
        "--base-url",
        "https://example.test",
      ]);
      expect(parsed.flags.json).toBe(true);
      expect(parsed.flags["no-color"]).toBe(true);
      expect(parsed.flags["base-url"]).toBe("https://example.test");
    }
  });

  it("resolves `me` to whoami", () => {
    expect(command(["me"]).command.name).toBe("whoami");
    expect(command(["whoami"]).command.name).toBe("whoami");
  });
});

describe("flag shapes", () => {
  it("takes a value as a separate token or after an equals sign", () => {
    expect(command(["new", "--ttl", "900"]).flags.ttl).toBe(900);
    expect(command(["new", "--ttl=900"]).flags.ttl).toBe(900);
    expect(command(["new", "--domain=mailtemp.dev"]).flags.domain).toBe("mailtemp.dev");
  });

  it("treats --timeout as an alias of --wait on code", () => {
    expect(command(["code", "a@b.com", "--timeout", "30"]).flags.wait).toBe(30);
    expect(command(["code", "a@b.com", "--wait", "30"]).flags.wait).toBe(30);
  });

  it("reads -h as --help", () => {
    expect(parseArgv(["code", "-h"]).kind).toBe("help");
    expect(parseArgv(["-h"]).kind).toBe("help");
    expect(parseArgv(["--help"]).kind).toBe("help");
  });

  it("prints usage with no arguments at all", () => {
    expect(parseArgv([]).kind).toBe("help");
  });

  it("recognises --version and -V", () => {
    expect(parseArgv(["--version"]).kind).toBe("version");
    expect(parseArgv(["-V"]).kind).toBe("version");
  });

  it("scopes per-command help to that command", () => {
    const parsed = parseArgv(["help", "code"]);
    expect(parsed.kind).toBe("help");
    expect(parsed.kind === "help" ? parsed.command?.name : null).toBe("code");
  });

  it("accepts an explicit boolean value", () => {
    expect(command(["new", "--json=false"]).flags.json).toBe(false);
    expect(command(["new", "--json=true"]).flags.json).toBe(true);
  });

  it("stops flag parsing at --", () => {
    const parsed = command(["code", "--", "--weird@allogebra.com"]);
    expect(parsed.positionals).toEqual(["--weird@allogebra.com"]);
  });
});

describe("usage errors", () => {
  it("rejects an unknown flag rather than ignoring it", () => {
    expect(usageError(["new", "--ttls", "900"]).message).toContain("unknown flag `--ttls`");
  });

  it("rejects an unknown command", () => {
    expect(usageError(["send"]).message).toContain("unknown command `send`");
  });

  it("rejects a flag used as a command", () => {
    expect(usageError(["--ttl", "900"]).message).toContain("unknown flag `--ttl`");
  });

  it("rejects a value-taking flag with nothing after it", () => {
    expect(usageError(["code", "a@b.com", "--wait"]).message).toContain("needs a value");
    // A following flag is a forgotten argument, not the value.
    expect(usageError(["code", "a@b.com", "--from", "--json"]).message).toContain("needs a value");
  });

  it("rejects a non-integer where seconds are expected", () => {
    expect(usageError(["code", "a@b.com", "--wait", "soon"]).message).toContain(
      "needs a positive whole number",
    );
    expect(usageError(["code", "a@b.com", "--wait", "0"]).message).toContain(
      "needs a positive whole number",
    );
    expect(usageError(["ls", "a@b.com", "--limit", "-5"]).message).toContain("needs a value");
  });

  it("rejects a value on a switch", () => {
    expect(usageError(["new", "--json=yes"]).message).toContain("takes no value");
  });

  it("requires the address every address-taking command names", () => {
    for (const name of ["tail", "code", "ls", "rm"]) {
      expect(usageError([name]).message).toContain("`<address>` is required");
    }
  });

  it("rejects a second positional", () => {
    expect(usageError(["rm", "a@b.com", "b@b.com"]).message).toContain(
      "unexpected argument `b@b.com`",
    );
    expect(usageError(["whoami", "extra"]).message).toContain("unexpected argument `extra`");
  });

  it("carries the command through, so the error can print that command's usage", () => {
    expect(usageError(["ls", "a@b.com", "--nope"]).command?.name).toBe("ls");
  });
});

describe("typed readers", () => {
  it("only return a value of the type asked for", () => {
    const { flags } = command(["new", "--domain", "mailtemp.dev", "--ttl", "600", "--wait-code"]);
    expect(flagString(flags, "domain")).toBe("mailtemp.dev");
    expect(flagString(flags, "ttl")).toBeUndefined();
    expect(flagInteger(flags, "ttl")).toBe(600);
    expect(flagInteger(flags, "domain")).toBeUndefined();
    expect(flagBoolean(flags, "wait-code")).toBe(true);
    expect(flagBoolean(flags, "json")).toBe(false);
  });
});
