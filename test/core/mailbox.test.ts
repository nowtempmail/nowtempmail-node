/**
 * The mailbox handle: pagination, history iteration, and `waitFor*`.
 *
 * Every `waitFor*` test here corresponds to a way real inboxes break tests:
 *
 * - mail that landed before anyone waited for it (the default high-water mark),
 * - a stale code from before a resend (`ignoreExisting`),
 * - mail arriving that is not the mail you wanted (`messagesSeen` on timeout),
 * - the same message appearing on consecutive polls (dedupe by id).
 *
 * The mock clock is pinned to the real one so that `ignoreExisting`, which is
 * defined against `Date.now()`, is comparable with message timestamps.
 */

import { describe, expect, it } from "vitest";
import { MOCK_KEY, createMockApi } from "../helpers/mock-api.js";
import type { MockApiOptions } from "../helpers/mock-api.js";
import { NowTempMail } from "../../src/client.js";
import type { Mailbox } from "../../src/mailbox.js";
import { TimeoutError } from "../../src/errors.js";
import type { MessageSummary } from "../../src/types.js";

/** Fast polling; the poll cadence itself is covered in http.test.ts. */
const FAST = { pollIntervalMs: 5, timeoutMs: 400 } as const;

async function withMailbox(options: MockApiOptions = {}) {
  const api = createMockApi({ now: () => Date.now(), ...options });
  const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
  const mailbox = await ntm.mailboxes.create();
  api.requests.length = 0;
  return { api, ntm, mailbox };
}

const secondsAgo = (n: number) => Math.floor(Date.now() / 1000) - n;
const secondsFromNow = (n: number) => Math.floor(Date.now() / 1000) + n;

/* -------------------------------------------------------------------------- */

describe("messages.page()", () => {
  it("returns summaries newest first, with Dates", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { subject: "first", receivedAt: secondsAgo(20) });
    api.deliver(mailbox.address, { subject: "second", receivedAt: secondsAgo(10) });

    const page = await mailbox.messages.page();
    expect(page.messages.map((m) => m.subject)).toEqual(["second", "first"]);
    expect(page.messages[0]!.receivedAt).toBeInstanceOf(Date);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.messages[0]!.verificationCodes).toEqual(["482913"]);
  });

  it("passes limit and cursor through", async () => {
    const { api, mailbox } = await withMailbox();
    for (let i = 0; i < 5; i++) api.deliver(mailbox.address, { subject: `m${i}` });

    const first = await mailbox.messages.page({ limit: 2 });
    expect(first.messages).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await mailbox.messages.page({ limit: 2, cursor: first.nextCursor! });
    expect(second.messages).toHaveLength(2);
    expect(second.messages.map((m) => m.id)).not.toEqual(first.messages.map((m) => m.id));
  });

  it("surfaces an undecodable cursor as invalid_request", async () => {
    const { mailbox } = await withMailbox();
    await expect(mailbox.messages.page({ cursor: "%%%not-base64%%%" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("keeps one request in flight per handle", async () => {
    // Two overlapping polls double the request rate and buy no freshness.
    const api = createMockApi({ now: () => Date.now() });
    let inFlight = 0;
    let peak = 0;
    const gated: typeof globalThis.fetch = async (input, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await api.fetch(input, init);
      } finally {
        inFlight--;
      }
    };
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: gated });
    const mailbox = await ntm.mailboxes.create();
    api.deliver(mailbox.address);

    await Promise.all([
      mailbox.messages.page(),
      mailbox.messages.page(),
      mailbox.messages.page(),
      mailbox.refresh(),
    ]);
    expect(peak).toBe(1);
  });
});

describe("messages.list()", () => {
  it("auto-paginates across several pages and terminates", async () => {
    const { api, mailbox } = await withMailbox();
    for (let i = 0; i < 7; i++) api.deliver(mailbox.address, { subject: `m${i}` });

    const seen: MessageSummary[] = [];
    for await (const message of mailbox.messages.list({ limit: 3 })) seen.push(message);

    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((m) => m.id)).size).toBe(7);
    // 3 + 3 + 1, then it stops rather than looping on an exhausted cursor.
    expect(api.requests.filter((r) => r.path.endsWith("/messages"))).toHaveLength(3);
  });

  it("yields nothing for an empty mailbox in one request", async () => {
    const { api, mailbox } = await withMailbox();
    const seen: MessageSummary[] = [];
    for await (const message of mailbox.messages.list()) seen.push(message);
    expect(seen).toEqual([]);
    expect(api.requests).toHaveLength(1);
  });

  it("can be abandoned part way without hanging", async () => {
    const { api, mailbox } = await withMailbox();
    for (let i = 0; i < 9; i++) api.deliver(mailbox.address, { subject: `m${i}` });
    const ids: string[] = [];
    for await (const message of mailbox.messages.list({ limit: 2 })) {
      ids.push(message.id);
      if (ids.length === 3) break;
    }
    expect(ids).toHaveLength(3);
  });
});

describe("messages.get() and delete()", () => {
  it("returns the full message and then removes it", async () => {
    const { api, mailbox } = await withMailbox();
    const stored = api.deliver(mailbox.address, {
      subject: "Your invoice",
      text: "Invoice attached.",
      html: "<p>Invoice attached.</p>",
      verificationCodes: [],
    });

    const message = await mailbox.messages.get(stored.id);
    expect(message.id).toBe(stored.id);
    expect(message.to).toBe(mailbox.address);
    expect(message.text).toBe("Invoice attached.");
    expect(message.html).toBe("<p>Invoice attached.</p>");
    expect(message.receivedAt).toBeInstanceOf(Date);
    expect(message.code).toBeNull();

    await expect(mailbox.messages.delete(stored.id)).resolves.toBeUndefined();
    await expect(mailbox.messages.get(stored.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

/* -------------------------------------------------------------------------- */

describe("waitForCode", () => {
  it("resolves from a code that arrived BEFORE the call", async () => {
    // The whole reason the high-water mark defaults to createdAt. A signup form
    // submits, the mail lands in 300ms, and the test gets around to waiting a
    // second later — that message must not be invisible.
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { verificationCodes: ["482913"] });

    await expect(mailbox.waitForCode(FAST)).resolves.toBe("482913");
  });

  it("never fetches a body — the code rides on the summary", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { verificationCodes: ["135790"] });

    await expect(mailbox.waitForCode(FAST)).resolves.toBe("135790");
    expect(api.requests.every((r) => r.path.endsWith("/messages"))).toBe(true);
  });

  it("picks up a code that arrives mid-wait", async () => {
    const { api, mailbox } = await withMailbox();
    setTimeout(() => api.deliver(mailbox.address, { verificationCodes: ["246802"] }), 30);
    await expect(mailbox.waitForCode({ pollIntervalMs: 5, timeoutMs: 2_000 })).resolves.toBe(
      "246802",
    );
  });

  it("skips a pre-existing code when ignoreExisting is set — the resend case", async () => {
    // On a resend the stale code is the bug: it verifies, the test passes, and
    // the resend path is never actually exercised.
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, {
      verificationCodes: ["111111"],
      receivedAt: secondsAgo(60),
    });

    let thrown: unknown;
    try {
      await mailbox.waitForCode({ ...FAST, ignoreExisting: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TimeoutError);
    // It saw the message. It refused to use it.
    expect((thrown as TimeoutError).messagesSeen).toBeGreaterThanOrEqual(1);
  });

  it("still accepts genuinely new mail when ignoreExisting is set", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { verificationCodes: ["111111"], receivedAt: secondsAgo(60) });
    api.deliver(mailbox.address, { verificationCodes: ["222222"], receivedAt: secondsFromNow(5) });

    await expect(mailbox.waitForCode({ ...FAST, ignoreExisting: true })).resolves.toBe("222222");
  });

  it("honours an explicit `after`", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { verificationCodes: ["333333"], receivedAt: secondsAgo(600) });
    api.deliver(mailbox.address, { verificationCodes: ["444444"], receivedAt: secondsAgo(5) });

    await expect(
      mailbox.waitForCode({ ...FAST, after: new Date(Date.now() - 60_000) }),
    ).resolves.toBe("444444");
  });

  it("times out with messagesSeen > 0 when mail arrives but nothing matches", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { subject: "Newsletter", verificationCodes: [] });
    api.deliver(mailbox.address, { subject: "Also not it", verificationCodes: [] });

    let thrown: unknown;
    try {
      await mailbox.waitForCode(FAST);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TimeoutError);
    const err = thrown as TimeoutError;
    expect(err.code).toBe("timeout");
    expect(err.address).toBe(mailbox.address);
    expect(err.messagesSeen).toBe(2);
    expect(err.waitedMs).toBeGreaterThan(0);
    // The count is the whole point: "nothing arrived" and "nothing matched" are
    // different bugs and the message has to distinguish them.
    expect(err.message).toContain("2 message(s)");
  });

  it("reports zero when nothing arrived at all", async () => {
    const { mailbox } = await withMailbox();
    let thrown: unknown;
    try {
      await mailbox.waitForCode(FAST);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as TimeoutError).messagesSeen).toBe(0);
  });

  it("dedupes by message id across polls", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { verificationCodes: [] });

    let thrown: unknown;
    try {
      await mailbox.waitForCode({ pollIntervalMs: 1, timeoutMs: 150 });
    } catch (err) {
      thrown = err;
    }
    // Many polls, one message. Counting it once is what proves the dedupe.
    expect(api.requests.length).toBeGreaterThan(3);
    expect((thrown as TimeoutError).messagesSeen).toBe(1);
  });

  it("registers and releases a watcher for the duration", async () => {
    const { api, ntm, mailbox } = await withMailbox();
    expect(ntm.http.watchers).toBe(0);

    const pending = mailbox.waitForCode({ pollIntervalMs: 5, timeoutMs: 2_000 });
    expect(ntm.http.watchers).toBe(1);
    api.deliver(mailbox.address, { verificationCodes: ["555555"] });

    await expect(pending).resolves.toBe("555555");
    expect(ntm.http.watchers).toBe(0);
  });

  it("waits out a rate limit instead of failing the wait", async () => {
    // The transport already retried and slept for Retry-After; arriving here
    // means the minute window is genuinely spent. A wait is supposed to be
    // patient, so it sleeps rather than throwing 429 at the caller.
    const api = createMockApi({ now: () => Date.now() });
    let fired = false;
    const throttled: typeof globalThis.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!fired && url.includes("/messages")) {
        fired = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "https://nowtempmail.com/developers/errors#rate_limit_exceeded",
              code: "rate_limit_exceeded",
              title: "Rate limit exceeded",
              status: 429,
              detail: "You have exceeded 30 requests per minute on the Free plan.",
              requestId: "req_abcdefghijklmnopqrst",
            }),
            {
              status: 429,
              headers: { "Content-Type": "application/problem+json", "Retry-After": "2" },
            },
          ),
        );
      }
      return api.fetch(input, init);
    };
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: throttled, maxRetries: 0 });
    const mailbox = await ntm.mailboxes.create();

    let thrown: unknown;
    try {
      await mailbox.waitForCode({ pollIntervalMs: 5, timeoutMs: 250 });
    } catch (err) {
      thrown = err;
    }
    expect(fired).toBe(true);
    // A TimeoutError, not a RateLimitExceededError: the 429 was absorbed.
    expect(thrown).toBeInstanceOf(TimeoutError);
  });

  it("propagates an error that is not worth waiting on", async () => {
    const { ntm } = await withMailbox();
    const missing = ntm.mailboxes.attach("nobody@allogebra.com");
    await expect(missing.waitForCode(FAST)).rejects.toMatchObject({ code: "not_found" });
  });

  it("respects an AbortSignal", async () => {
    const { mailbox } = await withMailbox();
    const controller = new AbortController();
    const pending = mailbox.waitForCode({
      pollIntervalMs: 5,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("suite tore down")), 20);
    await expect(pending).rejects.toMatchObject({ code: "connection_error" });
  });
});

/* -------------------------------------------------------------------------- */

describe("waitForMessage", () => {
  it("resolves with the full message, bodies included", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, {
      subject: "Reset your password",
      text: "Open https://example.com/reset?t=abc to continue.",
    });

    const message = await mailbox.waitForMessage(FAST);
    expect(message.subject).toBe("Reset your password");
    expect(message.text).toContain("https://example.com/reset");
    expect(message.links().map((u) => u.href)).toContain("https://example.com/reset?t=abc");
  });

  it("filters on `from` as a case-insensitive substring", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { from: "Stripe <no-reply@stripe.com>", subject: "receipt" });
    api.deliver(mailbox.address, { from: "GitHub <noreply@github.com>", subject: "verify" });

    const message = await mailbox.waitForMessage({ ...FAST, from: "STRIPE.COM" });
    expect(message.subject).toBe("receipt");
    expect(message.fromAddress).toBe("no-reply@stripe.com");
  });

  it("filters on `subject` with a RegExp", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { subject: "Weekly digest" });
    api.deliver(mailbox.address, { subject: "[GitHub] Please verify your device" });

    const message = await mailbox.waitForMessage({ ...FAST, subject: /^\[GitHub]/ });
    expect(message.subject).toContain("GitHub");
  });

  it("filters with a custom match callback", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { subject: "no attachment" });
    api.deliver(mailbox.address, {
      subject: "with attachment",
      attachments: [
        { filename: "invoice.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2]) },
      ],
    });

    const message = await mailbox.waitForMessage({
      ...FAST,
      match: (m) => m.attachmentCount > 0,
    });
    expect(message.subject).toBe("with attachment");
    expect(message.attachments).toHaveLength(1);
  });

  it("requires every supplied filter to pass", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { from: "GitHub <noreply@github.com>", subject: "digest" });

    let thrown: unknown;
    try {
      await mailbox.waitForMessage({ ...FAST, from: "github.com", subject: "verify" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TimeoutError);
    expect((thrown as TimeoutError).messagesSeen).toBe(1);
  });

  it("prefers the newest match, which is what a resend flow needs", async () => {
    const { api, mailbox } = await withMailbox();
    api.deliver(mailbox.address, { subject: "code 1" });
    api.deliver(mailbox.address, { subject: "code 2", receivedAt: secondsFromNow(1) });

    const message = await mailbox.waitForMessage(FAST);
    expect(message.subject).toBe("code 2");
  });
});

/* -------------------------------------------------------------------------- */

describe("expiry", () => {
  it("computes expired and expiresInMs from the creation response", async () => {
    const { mailbox } = await withMailbox();
    expect(mailbox.expired).toBe(false);
    expect(mailbox.expiresInMs).toBeGreaterThan(86_000_000);
    expect(mailbox.ttlSeconds).toBe(86_400);
  });

  it("reports expired once expiresAt has passed", async () => {
    const api = createMockApi({ now: () => Date.now() });
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    const mailbox: Mailbox = await ntm.mailboxes.create({ ttlSeconds: 300 });
    expect(mailbox.expired).toBe(false);

    // Wind the stored record back so the next refresh reports a past expiry.
    const record = api.state.mailboxes.get(mailbox.address)!;
    record.createdAt -= 600;
    record.expiresAt -= 600;
    await mailbox.refresh();

    expect(mailbox.expired).toBe(true);
    expect(mailbox.expiresInMs).toBe(0);
  });
});
