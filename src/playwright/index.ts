/**
 * `nowtempmail/playwright` — fixtures for `@playwright/test`.
 *
 * ```ts
 * import { test, expect } from "nowtempmail/playwright";
 *
 * test("signup", async ({ page, inbox }) => {
 *   await page.goto("/signup");
 *   await page.getByLabel("Email").fill(inbox.address);
 *   await page.getByRole("button", { name: "Create account" }).click();
 *   const code = await inbox.waitForCode();      // only this test's mail
 *   await page.getByLabel("Code").fill(code);
 * });
 * ```
 *
 * Three decisions in this module are worth reading before you use it, because
 * all three are counter-intuitive and all three come from how the API actually
 * meters and how CI artifacts actually leak:
 *
 * 1. **`inbox` is worker-scoped and shared.** A per-test mailbox would be the
 *    obvious design and it is the wrong one — see the fixture's own JSDoc.
 * 2. **Because it is shared, waits are watermarked per test.** `inbox` carries a
 *    watermark that a per-test auto fixture re-stamps at the start of every test,
 *    and `waitForCode()`/`waitForMessage()` default the filter's `after` to it.
 *    Without that, test #7 happily resolves with the code test #3 triggered and
 *    the suite passes while testing nothing. See {@link computeWatermark}.
 * 3. **Trace attachments are redacted by default.** Subject, sender, timestamp
 *    and extracted codes go into the report; bodies and links do not. See
 *    {@link redactForTrace}.
 *
 * `@playwright/test` is an **optional** peer. This module loads it lazily and
 * guarded, so importing `nowtempmail` in a project that has never installed
 * Playwright cannot crash at import time; the error surfaces only when a fixture
 * is actually used.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { ConfigError } from "../errors.js";
import { NowTempMail } from "../client.js";
import type { ClientOptions } from "../client.js";
import type { Mailbox, MessageFilter } from "../mailbox.js";
import type { Message } from "../message.js";
import type { CreateMailboxParams, MessagePage, MessageSummary } from "../types.js";

import type {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestInfo,
  TestType,
} from "@playwright/test";

/** Type-only view of the peer. Erased at compile time — never a runtime import. */
type PlaywrightModule = typeof import("@playwright/test");
type BaseTestType = PlaywrightModule["test"];
type BaseExpect = PlaywrightModule["expect"];

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The overridable option fixture. Set it per project or per file:
 *
 * ```ts
 * test.use({ ntmOptions: { baseUrl: "https://nowtempmail.com", attachBody: false } });
 * ```
 *
 * Everything a {@link ClientOptions} accepts is accepted here, plus the four
 * fixture-only knobs below.
 */
export interface NtmOptions extends ClientOptions {
  /** Default: `process.env.NTM_API_KEY`. */
  apiKey?: string;
  /** Default `https://nowtempmail.com`. */
  baseUrl?: string;
  /**
   * Put message bodies and links into the Playwright report.
   *
   * **Default `false`, and leaving it that way is the right call in CI.** See
   * {@link redactForTrace} for why.
   */
  attachBody?: boolean;
  /** Passed to `mailboxes.create()` for both `inbox` and `freshInbox`. */
  mailbox?: CreateMailboxParams;
  /**
   * How far back of the test's start instant the per-test watermark is placed,
   * in ms. Default {@link DEFAULT_WATERMARK_SKEW_MS}. Raise it if your CI clock
   * runs ahead of the API's; lower it to zero if two tests in the same file
   * trigger mail so close together that a 1s window is ambiguous.
   */
  watermarkSkewMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Watermarking                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One second. `receivedAt` on the wire has one-second granularity and a CI
 * runner's clock is not the API's clock, so a watermark placed at exactly the
 * test's start instant can sit *after* the timestamp of mail that test caused.
 * That failure mode is a timeout with `messagesSeen > 0`, which reads as "the
 * mail never arrived" and is the least debuggable outcome available.
 */
export const DEFAULT_WATERMARK_SKEW_MS = 1_000;

/**
 * The per-test high-water mark: the start of the second the test began in, minus
 * `skewMs`.
 *
 * Flooring to the second matters as much as the skew does. Comparing a
 * millisecond-precision local timestamp against a second-precision server one
 * discards up to 999ms of mail for no reason.
 */
export function computeWatermark(
  startedAtMs: number,
  skewMs: number = DEFAULT_WATERMARK_SKEW_MS,
): Date {
  const skew = Number.isFinite(skewMs) && skewMs > 0 ? skewMs : 0;
  const floored = Math.floor((startedAtMs - skew) / 1000) * 1000;
  return new Date(Math.max(0, floored));
}

/**
 * Default a filter's `after` to the watermark, without overriding anything the
 * caller said explicitly.
 *
 * `ignoreExisting` wins outright: it means "only mail from now on", which is a
 * strictly narrower request than the watermark, and `Mailbox` already gives it
 * precedence. An explicit `after` wins too — a caller who names a boundary has
 * out-argued the fixture.
 */
export function applyWatermark(
  filter: MessageFilter | undefined,
  watermark: Date,
): MessageFilter {
  const next: MessageFilter = { ...(filter ?? {}) };
  if (next.ignoreExisting) return next;
  if (next.after === undefined) next.after = watermark;
  return next;
}

/* -------------------------------------------------------------------------- */
/* Trace redaction                                                            */
/* -------------------------------------------------------------------------- */

/** Anything with enough of a message on it to describe in a report. */
export interface TraceMessageLike {
  id?: string;
  from: string;
  subject: string;
  receivedAt: Date;
  verificationCodes: readonly string[];
  text?: string | null;
  html?: string | null;
  links?: () => URL[];
}

export interface RedactedTracePayload {
  /** `false` only when `attachBody` was opted into. */
  redacted: boolean;
  id: string | null;
  from: string;
  subject: string;
  receivedAt: string;
  verificationCodes: string[];
  /** How many links the body contained. The links themselves are the secret. */
  linkCount: number;
  bodyChars: number;
  note: string;
  text?: string | null;
  html?: string | null;
  links?: string[];
}

const REDACTED_NOTE =
  "Bodies and links are omitted. A Playwright trace is a shareable CI artifact " +
  "and a password-reset link inside one is a live credential, not a log line. " +
  "Set ntmOptions.attachBody = true to include them.";

const REDACTED_NOTE_NO_BODY =
  "No body was fetched: waitForCode() resolves from the message summary, because " +
  "verification codes are extracted server-side at ingest. " +
  REDACTED_NOTE;

const UNREDACTED_NOTE =
  "ntmOptions.attachBody is true, so this attachment contains the full message " +
  "body and every link in it. Treat this trace as a secret: a password-reset or " +
  "magic-link URL in here is a live credential that anyone with the artifact can " +
  "spend.";

/**
 * Build the report payload for a matched message.
 *
 * **Redacted by default.** Subject, sender, `receivedAt` and the extracted codes
 * are enough to debug "the wrong mail matched", which is the only failure a
 * trace is really asked about. Bodies and links are not, and a trace is the
 * wrong place to keep them: it is zipped into a CI artifact, downloaded by
 * whoever has repo read access, and pasted into issues. A password-reset link
 * inside one is a live credential with a working expiry.
 *
 * The codes are attached deliberately even though they are secrets — a
 * verification code is single-use, already consumed by the time the trace is
 * read, and it is the one value you cannot debug an OTP flow without.
 */
export function redactForTrace(
  message: TraceMessageLike,
  options: { attachBody?: boolean } = {},
): RedactedTracePayload {
  const attachBody = options.attachBody === true;
  const bodyFetched = message.text !== undefined || message.html !== undefined;
  const text = message.text ?? null;
  const html = message.html ?? null;
  const links = bodyFetched ? collectLinks(message) : [];

  const payload: RedactedTracePayload = {
    redacted: !attachBody,
    id: message.id ?? null,
    from: message.from,
    subject: message.subject,
    receivedAt: message.receivedAt.toISOString(),
    verificationCodes: [...message.verificationCodes],
    linkCount: links.length,
    bodyChars: (text?.length ?? 0) + (html?.length ?? 0),
    note: attachBody ? UNREDACTED_NOTE : bodyFetched ? REDACTED_NOTE : REDACTED_NOTE_NO_BODY,
  };

  if (attachBody) {
    payload.text = text;
    payload.html = html;
    payload.links = links.map((u) => u.href);
  }
  return payload;
}

/** The `testInfo.attach()` arguments for a matched message. */
export function traceAttachment(
  message: TraceMessageLike,
  options: { attachBody?: boolean } = {},
): { name: string; contentType: string; body: string } {
  return {
    name: "nowtempmail-message.json",
    contentType: "application/json",
    body: JSON.stringify(redactForTrace(message, options), null, 2),
  };
}

function collectLinks(message: TraceMessageLike): URL[] {
  if (typeof message.links === "function") {
    try {
      return message.links();
    } catch {
      return [];
    }
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* The inbox handle                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Mutable per-worker cell. The `inbox` fixture is worker-scoped, so it cannot
 * know which test is running; the per-test auto fixture writes that here and the
 * inbox reads it. This indirection *is* the watermark mechanism.
 */
interface InboxContext {
  watermark: Date;
  testInfo: TestInfo | null;
  attachBody: boolean;
  watermarkSkewMs: number;
}

/**
 * A {@link Mailbox} that knows which test is looking at it.
 *
 * Every wait defaults its `after` boundary to the current test's watermark, and
 * every match is attached to the Playwright report — redacted unless
 * `ntmOptions.attachBody` says otherwise. Reach through to {@link TestInbox.mailbox}
 * for anything this wrapper does not forward.
 */
export class TestInbox {
  /** The unwrapped handle. No watermarking, no trace attachment. */
  readonly mailbox: Mailbox;
  readonly #ctx: InboxContext;

  constructor(mailbox: Mailbox, ctx: InboxContext) {
    this.mailbox = mailbox;
    this.#ctx = ctx;
  }

  get address(): string {
    return this.mailbox.address;
  }
  get localPart(): string {
    return this.mailbox.localPart;
  }
  get domain(): string {
    return this.mailbox.domain;
  }
  get createdAt(): Date {
    return this.mailbox.createdAt;
  }
  get expiresAt(): Date {
    return this.mailbox.expiresAt;
  }
  get expired(): boolean {
    return this.mailbox.expired;
  }
  get expiresInMs(): number {
    return this.mailbox.expiresInMs;
  }
  get messageCount(): number {
    return this.mailbox.messageCount;
  }
  get confirmed(): boolean {
    return this.mailbox.confirmed;
  }
  get messages(): Mailbox["messages"] {
    return this.mailbox.messages;
  }

  /**
   * The boundary this test's waits start from. Re-stamped at the start of every
   * test, which is what stops a shared inbox from resolving with a neighbour's
   * code. Read it if you need to pass it to something else; you never need to
   * set it.
   */
  get watermark(): Date {
    return this.#ctx.watermark;
  }

  async refresh(): Promise<Mailbox> {
    return this.mailbox.refresh();
  }

  async delete(): Promise<{ deletedMessages: number }> {
    return this.mailbox.delete();
  }

  /** One page of summaries, newest first. Not watermarked — an explicit read. */
  async page(opts: { limit?: number; cursor?: string } = {}): Promise<MessagePage> {
    return this.mailbox.messages.page(opts);
  }

  /**
   * Wait for a verification code from **this test's** mail.
   *
   * `filter.after` defaults to {@link TestInbox.watermark}, so a code triggered
   * by an earlier test in the same worker is invisible here. Pass `after`
   * yourself, or `ignoreExisting: true`, to override that.
   */
  async waitForCode(filter: MessageFilter = {}): Promise<string> {
    const resolved = applyWatermark(filter, this.#ctx.watermark);

    // `waitForCode` resolves with a bare string, but the report needs the
    // message it came from. Rather than spend a request fetching the body back
    // (which would also undo "never fetches a body"), record every summary the
    // filter accepted and pick the one carrying the code we were handed.
    const candidates: MessageSummary[] = [];
    const userMatch = resolved.match;
    resolved.match = (m: MessageSummary): boolean => {
      if (userMatch && !userMatch(m)) return false;
      candidates.push(m);
      return true;
    };

    const code = await this.mailbox.waitForCode(resolved);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (candidate && candidate.verificationCodes[0] === code) {
        await this.#attach(candidate);
        break;
      }
    }
    return code;
  }

  /** Wait for a message from **this test's** mail. Watermarked like {@link waitForCode}. */
  async waitForMessage(filter: MessageFilter = {}): Promise<Message> {
    const message = await this.mailbox.waitForMessage(applyWatermark(filter, this.#ctx.watermark));
    await this.#attach(message);
    return message;
  }

  /** Attaching to the report must never be the reason a passing test fails. */
  async #attach(message: TraceMessageLike): Promise<void> {
    const info = this.#ctx.testInfo;
    if (!info) return;
    try {
      const { name, contentType, body } = traceAttachment(message, {
        attachBody: this.#ctx.attachBody,
      });
      await info.attach(name, { body, contentType });
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fixture types                                                              */
/* -------------------------------------------------------------------------- */

export interface NtmTestFixtures {
  /**
   * **Costs one mailbox out of the daily quota per test, and the quota is never
   * refunded** — a 40-test file burns 40 of the Free plan's 50/day, and deleting
   * the mailbox on teardown does not give any of them back.
   *
   * Use it only for the tests that genuinely cannot share: a flow asserting on
   * an empty inbox, one that deletes messages out from under a sibling, or one
   * that needs a mailbox with a different domain or TTL. Everything else should
   * use {@link NtmWorkerFixtures.inbox}, whose watermarking already isolates
   * tests from each other.
   *
   * The mailbox is created before the test and deleted after it. Because it is
   * fresh, its waits default to the mailbox's own `createdAt` rather than to a
   * watermark — every message in it belongs to this test by construction.
   */
  freshInbox: TestInbox;
  /** Internal: stamps the per-test watermark. Auto, do not depend on it. */
  _ntmTestStamp: void;
}

export interface NtmWorkerFixtures {
  /** See {@link NtmOptions}. Override with `test.use({ ntmOptions: { ... } })`. */
  ntmOptions: NtmOptions;
  /** The client, one per worker. Reads `NTM_API_KEY` unless `ntmOptions.apiKey` is set. */
  ntm: NowTempMail;
  /**
   * One mailbox, **reused by every test in the worker.** This is the default and
   * it is deliberate.
   *
   * `POST /v1/mailboxes` is the only endpoint that consumes daily quota, the
   * counter increments on creation, and **it is never decremented on delete**.
   * A per-test mailbox therefore spends the Free plan's 50 mailboxes/day inside a
   * single CI run — the suite goes green locally, then starts failing with
   * `quota_exceeded` partway through the third run of the afternoon, and the
   * failure has nothing to do with the code that triggered it.
   *
   * The cost of sharing is that the address is not unique to a test, so **tests
   * must disambiguate on content, not on address.** That is handled for you:
   * `waitForCode()` and `waitForMessage()` default their `after` boundary to a
   * watermark re-stamped at the start of every test, so a code from an earlier
   * test is not a candidate. Add `subject` or `from` to the filter when two
   * tests in the same file trigger mail from the same sender within a second.
   *
   * Not deleted on teardown: the quota is already spent either way, and leaving
   * it to expire means a post-mortem can still read what actually arrived.
   */
  inbox: TestInbox;
  /** Internal: the mutable cell the watermark lives in. Do not depend on it. */
  _ntmContext: InboxContext;
}

/** The extended `test` object this module exports. */
export type NowTempMailTestType = TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & NtmTestFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & NtmWorkerFixtures
>;

/* -------------------------------------------------------------------------- */
/* Peer loading                                                               */
/* -------------------------------------------------------------------------- */

const MISSING_PEER =
  "nowtempmail/playwright requires @playwright/test, which is an optional peer " +
  "dependency and could not be resolved. Install it in the project that runs " +
  "these tests: `npm i -D @playwright/test` (>=1.40). If it is installed, check " +
  "that it resolves from the directory you run Playwright from.";

/**
 * Resolve the peer synchronously, or `null`.
 *
 * `import.meta` is deliberately not referenced: this file is also built to CJS,
 * where esbuild replaces `import.meta` with an empty object and emits a build
 * warning. `__filename` exists in the CJS output and not in the ESM one, so the
 * ESM build resolves from the working directory instead — which for a Playwright
 * run is the project that owns the peer anyway.
 */
function loadPlaywrightPeer(): PlaywrightModule | null {
  const base =
    typeof __filename === "string" ? __filename : path.join(process.cwd(), "index.js");
  try {
    return createRequire(base)("@playwright/test") as PlaywrightModule;
  } catch {
    /* fall through to the cwd attempt */
  }
  try {
    return createRequire(path.join(process.cwd(), "index.js"))(
      "@playwright/test",
    ) as PlaywrightModule;
  } catch {
    return null;
  }
}

/**
 * Stand-in for a peer that is not installed.
 *
 * Importing this module must not throw — a consumer's bundler or a stray
 * `import "nowtempmail/playwright"` in a non-Playwright file should not take
 * their process down. So `test` and `expect` become objects that are inert until
 * touched, and explain themselves when they are.
 */
function missingPeerStub<T>(): T {
  const fail = (): never => {
    throw new ConfigError(MISSING_PEER);
  };
  const target = (): never => fail();
  return new Proxy(target, {
    apply: fail,
    get(_target, prop) {
      // Symbols and the handful of names a runtime probes reflexively must stay
      // inert, or `console.log(test)` and `await import(...)` would throw.
      if (typeof prop === "symbol") return undefined;
      if (prop === "then" || prop === "toJSON" || prop === "name" || prop === "length") {
        return undefined;
      }
      return fail();
    },
  }) as T;
}

/* -------------------------------------------------------------------------- */
/* The fixtures                                                               */
/* -------------------------------------------------------------------------- */

function buildTest(base: BaseTestType): NowTempMailTestType {
  return base.extend<NtmTestFixtures, NtmWorkerFixtures>({
    ntmOptions: [{}, { scope: "worker", option: true }],

    ntm: [
      async ({ ntmOptions }, use) => {
        await use(new NowTempMail(toClientOptions(ntmOptions)));
      },
      { scope: "worker" },
    ],

    _ntmContext: [
      async ({ ntmOptions }, use) => {
        // Deliberately does not depend on `ntm`: this fixture is pulled in by an
        // auto fixture, so every test in the project would otherwise construct a
        // client and fail on a missing NTM_API_KEY even if it never sends mail.
        await use({
          watermark: new Date(0),
          testInfo: null,
          attachBody: ntmOptions.attachBody === true,
          watermarkSkewMs: ntmOptions.watermarkSkewMs ?? DEFAULT_WATERMARK_SKEW_MS,
        });
      },
      { scope: "worker" },
    ],

    /**
     * The whole reason a shared `inbox` is usable. Runs before every test, moves
     * the watermark to this test's start, and points the inbox at this test's
     * report. Nothing else in this module makes a network call to do it.
     */
    _ntmTestStamp: [
      async ({ _ntmContext }, use, testInfo) => {
        _ntmContext.watermark = computeWatermark(Date.now(), _ntmContext.watermarkSkewMs);
        _ntmContext.testInfo = testInfo;
        try {
          await use();
        } finally {
          _ntmContext.testInfo = null;
        }
      },
      { auto: true },
    ],

    inbox: [
      async ({ ntm, ntmOptions, _ntmContext }, use) => {
        const mailbox = await ntm.mailboxes.create(ntmOptions.mailbox ?? {});
        await use(new TestInbox(mailbox, _ntmContext));
      },
      { scope: "worker" },
    ],

    freshInbox: async ({ ntm, ntmOptions }, use, testInfo) => {
      const mailbox = await ntm.mailboxes.create(ntmOptions.mailbox ?? {});
      const inbox = new TestInbox(mailbox, {
        // A fresh mailbox needs no watermark: every message in it is this test's.
        watermark: mailbox.createdAt,
        testInfo,
        attachBody: ntmOptions.attachBody === true,
        watermarkSkewMs: ntmOptions.watermarkSkewMs ?? DEFAULT_WATERMARK_SKEW_MS,
      });
      try {
        await use(inbox);
      } finally {
        // Cleanup failure is not a test failure, and the quota is spent regardless.
        await mailbox.delete().catch(() => undefined);
      }
    },
  });
}

/** Strip the fixture-only keys so `ClientOptions` sees only what it knows. */
function toClientOptions(options: NtmOptions): ClientOptions {
  const { attachBody: _a, mailbox: _m, watermarkSkewMs: _w, ...clientOptions } = options;
  return clientOptions;
}

const peer = loadPlaywrightPeer();

/**
 * `@playwright/test`'s `test`, extended with {@link NtmWorkerFixtures} and
 * {@link NtmTestFixtures}. Import it instead of the one from `@playwright/test`.
 */
export const test: NowTempMailTestType = peer
  ? buildTest(peer.test)
  : missingPeerStub<NowTempMailTestType>();

/** Re-exported unchanged from `@playwright/test`, so you need only one import. */
export const expect: BaseExpect = peer ? peer.expect : missingPeerStub<BaseExpect>();

/**
 * `false` when `@playwright/test` could not be resolved. For diagnostics — a
 * fixture that is actually used throws a `ConfigError` explaining itself.
 */
export const playwrightAvailable: boolean = peer !== null;

// No default export on purpose. `import test from "nowtempmail/playwright"` in a
// CJS consumer would land on `module.exports.default`, and the whole point of
// this module is that a spec file's first line works.
