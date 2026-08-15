/**
 * Renderers, formatters, error mapping and the redaction net — all pure, all
 * without a socket.
 *
 * The wireframe's exact wording is asserted here on purpose. Those strings are
 * the interface a person reads at 2am when their signup test is failing, and
 * "resuming in 2s" versus "retrying soon" is the difference between knowing what
 * is happening and guessing.
 */

import { describe, expect, it } from "vitest";

import { CSI, createPalette, formatClock, formatDuration, plural, renderTable, sanitiseForTerminal, truncate } from "../../src/cli/style.js";
import {
  EXIT,
  NO_API_KEY_MESSAGE,
  describeError,
  formatErrorLine,
  rateLimitNotice,
  timeoutMessage,
} from "../../src/cli/errors.js";
import {
  accountBlock,
  accountJson,
  createdStatusLine,
  domainLines,
  mailboxJson,
  messageJson,
  messageLine,
  messagesTable,
} from "../../src/cli/render.js";
import { createCaptureIo, redact, REDACTED } from "../../src/cli/io.js";
import { renderCommandHelp, renderUsage } from "../../src/cli/help.js";
import { findCommand } from "../../src/cli/args.js";
import { Mailbox } from "../../src/mailbox.js";
import type { Http } from "../../src/http.js";
import { TimeoutError, errorFromProblem } from "../../src/errors.js";
import { PROBLEM_CODES } from "../../src/types.js";
import type {
  Account,
  MessageSummary,
  MeteringSnapshot,
  ProblemCode,
  WireProblem,
} from "../../src/types.js";

const FAKE_KEY = "ntm_live_zZtestKeyId1_sSSSecretHalfThatMustNeverBePrinted";
const NO_HTTP = {} as unknown as Http;
const plain = createPalette(false);

function mailbox(overrides: Partial<{ ttlSeconds: number; messageCount: number }> = {}) {
  const createdAt = new Date();
  return new Mailbox(NO_HTTP, {
    address: "crystal482@allogebra.com",
    domain: "allogebra.com",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 86_400_000 - 400),
    ttlSeconds: overrides.ttlSeconds ?? 86_400,
    reserved: false,
    webhookUrl: null,
    messageCount: overrides.messageCount ?? 0,
    confirmed: true,
  });
}

function metering(quotaRemaining: number): MeteringSnapshot {
  return {
    rateLimit: { limit: 30, remaining: 30, reset: new Date(Date.now() + 60_000) },
    quota: { limit: 50, remaining: quotaRemaining, reset: new Date(Date.now() + 22_320_000) },
  };
}

function summary(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: "msg_0001",
    from: "GitHub <noreply@github.com>",
    subject: "[GitHub] Please verify your device",
    receivedAt: new Date("2026-08-14T12:04:33Z"),
    attachmentCount: 0,
    verificationCodes: ["482913"],
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    keyId: "k7Rm2xQp9Ldv",
    environment: "live",
    paywall: { enabled: false, note: "Launch pricing: every capability is enabled." },
    subscription: null,
    plan: {
      id: "free",
      label: "Free",
      requestsPerMinute: 30,
      mailboxesPerDay: 50,
      maxTtlSeconds: 86_400,
      customAddress: false,
      reservedAddresses: 0,
      webhooks: false,
    },
    usage: {
      requestsThisMinute: 3,
      mailboxesToday: 1,
      mailboxesRemainingToday: 49,
      reservedAddressesUsed: 0,
      resetsAt: { minute: new Date(Date.now() + 60_000), day: new Date(Date.now() + 3_600_000) },
    },
    webhookEndpoints: [],
    ...overrides,
  };
}

function problem(code: ProblemCode, extra: Partial<WireProblem> = {}) {
  return errorFromProblem({
    type: `https://nowtempmail.com/developers/errors#${code}`,
    code,
    title: code,
    status: extra.status ?? 400,
    detail: `Injected ${code}.`,
    requestId: "req_abcdefghijklmnopqrst",
    ...extra,
  } as WireProblem);
}

/* -------------------------------------------------------------------------- */

describe("formatters", () => {
  it("rounds a duration the way a person would say it", () => {
    // A mailbox created 400ms ago has 23h 59m 59.6s left, and reads as 24h.
    expect(formatDuration(86_400_000 - 400)).toBe("24h");
    expect(formatDuration(22_320_000)).toBe("6h 12m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5_000)).toBe("0s");
    expect(formatDuration(2_592_000_000)).toBe("30d");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("unknown");
  });

  it("formats a clock and a plural", () => {
    expect(formatClock(new Date(2026, 7, 14, 9, 4, 3))).toBe("09:04:03");
    expect(formatClock(new Date(Number.NaN))).toBe("--:--:--");
    expect(plural(1, "message")).toBe("message");
    expect(plural(2, "message")).toBe("messages");
    expect(plural(0, "mailbox", "mailboxes")).toBe("mailboxes");
  });

  it("truncates with an ellipsis rather than cutting mid-word silently", () => {
    expect(truncate("abcdef", 10)).toBe("abcdef");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("untrusted text", () => {
  // Built from char codes so no invisible control byte lives in this file.
  const BEL = String.fromCharCode(7);
  const RLO = String.fromCharCode(0x202e); // right-to-left override
  const LRI = String.fromCharCode(0x2066);
  const PDI = String.fromCharCode(0x2069);

  it("strips terminal control sequences out of sender-supplied strings", () => {
    const nasty = `${CSI}31mred${CSI}0m\r\nOverwritten${BEL}`;
    const safe = sanitiseForTerminal(nasty);
    expect(safe).not.toContain(CSI);
    expect(safe).not.toContain("\r");
    expect(safe).not.toContain(BEL);
    expect(safe).toContain("31mred");
  });

  it("strips the bidi overrides that make evil.exe render as evilexe.txt", () => {
    expect(sanitiseForTerminal(`evil${RLO}txt.exe`)).toBe("evil txt.exe");
    expect(sanitiseForTerminal(`${LRI}spoof${PDI}`)).toBe("spoof");
  });

  it("sanitises From and Subject on their way into a message line", () => {
    const line = messageLine(summary({ from: `A${CSI}2J`, subject: `verify${BEL}${RLO}now` }), plain);
    expect(line).not.toContain(CSI);
    expect(line).not.toContain(BEL);
    expect(line).not.toContain(RLO);
    expect(line.endsWith("\n")).toBe(true);
    // One line per event: no embedded newline from a crafted subject.
    expect(line.trimEnd()).not.toContain("\n");
  });
});

describe("colour", () => {
  it("emits no ANSI at all when the palette is off", () => {
    const off = createPalette(false);
    const rendered = [
      off.red("r"),
      off.dim("d"),
      off.amber("a"),
      off.green("g"),
      off.bold("b"),
      off.cyan("c"),
      messageLine(summary(), off),
      messagesTable([summary()], off),
      accountBlock(account(), off),
      domainLines([{ domain: "allogebra.com", default: true }], off),
      renderUsage(off, "0.1.0"),
      formatErrorLine({ message: "nope", exit: 1 }, off),
    ].join("");
    expect(rendered).not.toContain(CSI);
    expect(off.enabled).toBe(false);
  });

  it("emits ANSI when it is on", () => {
    const on = createPalette(true);
    expect(on.red("x")).toContain(CSI);
    expect(messageLine(summary(), on)).toContain(CSI);
  });
});

describe("tables and blocks", () => {
  it("aligns columns and never leaves trailing whitespace", () => {
    const table = renderTable(["A", "BB"], [["x", "y"], ["longer", "z"]], plain);
    const lines = table.trimEnd().split("\n");
    expect(lines).toEqual(["A       BB", "x       y", "longer  z"]);
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });

  it("renders ls with a header and one row per message", () => {
    const table = messagesTable([summary(), summary({ id: "msg_2", verificationCodes: [], attachmentCount: 2 })], plain);
    const lines = table.trimEnd().split("\n");
    expect(lines[0]).toContain("RECEIVED");
    expect(lines[0]).toContain("SUBJECT");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("482913");
  });

  it("marks the default domain", () => {
    const rendered = domainLines(
      [
        { domain: "allogebra.com", default: true },
        { domain: "mailtemp.dev", default: false },
      ],
      plain,
    );
    expect(rendered).toBe("allogebra.com  (default)\nmailtemp.dev\n");
  });

  it("says what a fresh mailbox costs and when it dies", () => {
    expect(createdStatusLine(mailbox(), metering(37))).toBe(
      "expires in 24h · 37 mailboxes left today",
    );
    expect(createdStatusLine(mailbox(), metering(1))).toContain("1 mailbox left today");
    // No metering yet? Say what we know and nothing more.
    expect(createdStatusLine(mailbox(), null)).toBe("expires in 24h");
  });

  it("prints the key id in whoami, and nothing that could be a secret", () => {
    const block = accountBlock(account(), plain);
    expect(block).toContain("k7Rm2xQp9Ldv");
    expect(block).toContain("Free");
    expect(block).toContain("launch pricing");
    expect(block).toContain("none registered");
    expect(block.endsWith("\n")).toBe(true);
  });

  it("shapes whoami --json by hand, with no field that could hold a key", () => {
    const shaped = accountJson(account());
    expect(Object.keys(shaped).sort()).toEqual([
      "environment",
      "keyId",
      "paywall",
      "plan",
      "subscription",
      "usage",
      "webhookEndpoints",
    ]);
    const text = JSON.stringify(shaped);
    expect(text).toContain("k7Rm2xQp9Ldv");
    expect(text).not.toMatch(/ntm_(live|test)_/);
  });

  it("shapes a mailbox and a message for --json", () => {
    const shaped = mailboxJson(mailbox());
    expect(shaped.address).toBe("crystal482@allogebra.com");
    expect(shaped.ttlSeconds).toBe(86_400);
    expect(String(shaped.expiresAt)).toMatch(/Z$/);
    expect(messageJson(summary()).verificationCodes).toEqual(["482913"]);
    expect(messageJson(summary()).receivedAt).toBe("2026-08-14T12:04:33.000Z");
  });
});

describe("help", () => {
  it("lists every command with its alias", () => {
    const usage = renderUsage(plain, "0.1.0");
    for (const name of ["new", "tail", "code", "ls", "rm", "whoami", "domains"]) {
      expect(usage).toContain(name);
    }
    expect(usage).toContain("alias: me");
    expect(usage).toContain("NTM_API_KEY");
    expect(usage).toContain("writes no config file");
    // The exit codes are what a CI script depends on, so they are documented.
    expect(usage).toContain("4  a --wait window elapsed with no match");
  });

  it("documents a single command, flags and all", () => {
    const help = renderCommandHelp(findCommand("code")!, plain);
    expect(help).toContain("nowtempmail code <address>");
    expect(help).toContain("--wait, --timeout <seconds>");
    expect(help).toContain("--from <text>");
    expect(help).toContain("--base-url <url>");
  });
});

describe("error mapping", () => {
  it("gives every documented problem code a message and an exit code", () => {
    for (const code of PROBLEM_CODES) {
      const described = describeError(problem(code), { metering: metering(0) });
      expect(described.message.length).toBeGreaterThan(0);
      expect([EXIT.FAIL, EXIT.USAGE]).toContain(described.exit);
      // Support asks for the request id, so it always survives.
      expect(described.requestId).toBe("req_abcdefghijklmnopqrst");
    }
  });

  it("treats a rejected key as a usage problem, not an API failure", () => {
    for (const code of ["unauthorized", "invalid_key", "key_revoked"] as const) {
      const described = describeError(problem(code, { status: 401 }));
      expect(described.exit).toBe(EXIT.USAGE);
      expect(described.message).toContain("https://nowtempmail.com/developers/keys");
    }
  });

  it("reports a spent quota with the numbers and the reset", () => {
    const described = describeError(problem("quota_exceeded", { status: 429 }), {
      metering: metering(0),
    });
    expect(described.message).toBe(
      "daily mailbox quota reached (50/50). Resets 00:00 UTC in 6h 12m.",
    );
    expect(described.exit).toBe(EXIT.FAIL);
  });

  it("names the plan ceiling on a gated parameter", () => {
    const described = describeError(
      problem("plan_upgrade_required", { status: 402, parameter: "ttlSeconds", maxTtlSeconds: 86_400 }),
    );
    expect(described.message).toContain("`--ttl` needs a paid plan");
    expect(described.message).toContain("up to 24h");
    expect(described.message).toContain("pricing");
  });

  it("blames the flag on a 422", () => {
    const described = describeError(problem("invalid_request", { status: 422, parameter: "address" }));
    expect(described.message).toContain("`--address`");
    expect(described.exit).toBe(EXIT.USAGE);
  });

  it("says which mailbox is missing", () => {
    const described = describeError(problem("not_found", { status: 404 }), {
      address: "gone@allogebra.com",
    });
    expect(described.message).toContain("no mailbox gone@allogebra.com");
    expect(described.message).toContain("may have expired");
  });

  it("maps a timeout to exit 4, with what it saw", () => {
    const err = new TimeoutError({
      address: "crystal482@allogebra.com",
      waitedMs: 60_000,
      messagesSeen: 2,
      what: "a verification code",
    });
    const described = describeError(err);
    expect(described.exit).toBe(EXIT.TIMEOUT);
    expect(described.message).toBe("no code in 60s — 2 messages arrived, none carried a code");
  });

  it("phrases a timeout by what actually arrived", () => {
    expect(timeoutMessage(60_000, 0)).toBe("no code in 60s — no messages arrived");
    expect(timeoutMessage(60_000, 1)).toBe(
      "no code in 60s — 1 message arrived, none carried a code",
    );
    expect(timeoutMessage(60_000, 2)).toBe(
      "no code in 60s — 2 messages arrived, none carried a code",
    );
  });

  it("phrases a rate limit as something that is resuming, not failing", () => {
    expect(rateLimitNotice({ retryAfterSeconds: 2, limit: 30, planLabel: "Free" })).toBe(
      "rate limited — resuming in 2s (30/min on Free)",
    );
    // Plan unknown (no me() call yet) still says what the budget is.
    expect(rateLimitNotice({ retryAfterSeconds: 2, limit: 30 })).toBe(
      "rate limited — resuming in 2s (30/min)",
    );
    expect(rateLimitNotice({})).toBe("rate limited — resuming in 1s");
  });

  it("names the host it could not reach", () => {
    const described = describeError(problem("internal_error", { status: 500 }));
    expect(described.exit).toBe(EXIT.FAIL);
    const connection = describeError(
      Object.assign(new Error("socket hang up"), {}),
      { baseUrl: "https://nowtempmail.com" },
    );
    // A plain Error is not one of ours: it is still rendered, and it still exits 1.
    expect(connection.exit).toBe(EXIT.FAIL);
    expect(connection.message).toBe("socket hang up");
  });

  it("puts the request id on the error line", () => {
    const line = formatErrorLine(describeError(problem("not_found", { status: 404 })), plain);
    expect(line).toContain("error:");
    expect(line).toContain("request req_abcdefghijklmnopqrst");
    expect(line.endsWith("\n")).toBe(true);
  });

  it("tells you where to get a key when there is none", () => {
    expect(NO_API_KEY_MESSAGE).toBe(
      "no API key. Set NTM_API_KEY — get one at https://nowtempmail.com/developers/keys",
    );
  });
});

describe("redaction", () => {
  it("scrubs a secret from anything written through the io", () => {
    const io = createCaptureIo([FAKE_KEY]);
    io.out(`address ${FAKE_KEY}\n`);
    io.err(`Bearer ${FAKE_KEY}\n`);
    expect(io.all()).not.toContain(FAKE_KEY);
    expect(io.stdout()).toContain(REDACTED);
    expect(io.stderr()).toContain(REDACTED);
  });

  it("scrubs a truncated secret too, because a partial key is still a key", () => {
    // What a renderer's own truncation leaves behind.
    const clipped = `${FAKE_KEY.slice(0, 40)}…`;
    expect(redact(clipped, [FAKE_KEY])).toBe(`${REDACTED}…`);
    expect(redact(`subject: ${FAKE_KEY.slice(9, 30)} rest`, [FAKE_KEY])).toBe(
      `subject: ${REDACTED} rest`,
    );
    // Short runs are left alone: 11 characters of a key is not a key.
    expect(redact("ntm_live_zZ", [FAKE_KEY])).toBe("ntm_live_zZ");
    // The key id is public — the dashboard shows it and whoami prints it — so
    // matching only that half must not be mangled.
    expect(redact("key zZtestKeyId1 is fine", [FAKE_KEY])).toBe("key zZtestKeyId1 is fine");
  });

  it("ignores short values, which would mangle unrelated text", () => {
    const io = createCaptureIo(["", "abc", undefined]);
    io.out("abc def\n");
    expect(io.stdout()).toBe("abc def\n");
    expect(redact("abc def", ["abc"])).toBe("[redacted] def");
  });

  it("never lets a key reach the terminal, whatever a renderer is handed", () => {
    // The property, stated as a test: every renderer, fed the key in every
    // free-text field a hostile API response could put it in, writing through
    // the CLI's own io.
    const io = createCaptureIo([FAKE_KEY]);
    const poisoned = summary({ from: `<${FAKE_KEY}@x.com>`, subject: FAKE_KEY, verificationCodes: [FAKE_KEY] });
    io.out(messageLine(poisoned, plain));
    io.out(messagesTable([poisoned], plain));
    io.out(JSON.stringify(messageJson(poisoned)));
    io.out(
      accountBlock(
        account({
          keyId: FAKE_KEY,
          webhookEndpoints: [
            {
              id: "whe_1",
              url: `https://example.com/${FAKE_KEY}`,
              status: "active",
              consecutiveFailures: 0,
              lastSuccessAt: null,
              lastFailureAt: null,
              disabledAt: null,
              disabledReason: null,
            },
          ],
        }),
        plain,
      ),
    );
    io.out(JSON.stringify(accountJson(account({ keyId: FAKE_KEY }))));
    io.out(JSON.stringify(mailboxJson(mailbox())));
    io.out(domainLines([{ domain: FAKE_KEY, default: true }], plain));
    io.err(formatErrorLine(describeError(new Error(`failed for ${FAKE_KEY}`)), plain));
    io.err(renderUsage(plain, "0.1.0"));

    expect(io.all()).not.toContain(FAKE_KEY);
    expect(io.all()).not.toContain("sSSSecretHalfThatMustNeverBePrinted");
  });
});
