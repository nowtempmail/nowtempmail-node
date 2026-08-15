/**
 * `src/playwright` — the parts that are testable without a browser.
 *
 * No Playwright browser is launched here and none is installed: this suite
 * covers the module's contract (it imports cleanly and exports `test`/`expect`),
 * the trace redaction rules, and the watermark arithmetic that makes a shared
 * worker-scoped inbox safe to reuse across tests. Those three are where the bugs
 * would be; the fixture plumbing itself is Playwright's code.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestInfo } from "@playwright/test";

import {
  DEFAULT_WATERMARK_SKEW_MS,
  TestInbox,
  applyWatermark,
  computeWatermark,
  expect as ntmExpect,
  playwrightAvailable,
  redactForTrace,
  test as ntmTest,
  traceAttachment,
} from "../../src/playwright/index.js";
import { NowTempMail } from "../../src/client.js";
import type { Mailbox } from "../../src/mailbox.js";
import { MOCK_KEY, createMockApi } from "../helpers/mock-api.js";
import type { MockApi } from "../helpers/mock-api.js";

/* -------------------------------------------------------------------------- */
/* Module contract                                                            */
/* -------------------------------------------------------------------------- */

describe("module contract", () => {
  it("imports without a Playwright runner and resolves the peer", () => {
    expect(playwrightAvailable).toBe(true);
  });

  it("exports a callable `test` with the Playwright surface on it", () => {
    expect(typeof ntmTest).toBe("function");
    expect(typeof ntmTest.extend).toBe("function");
    expect(typeof ntmTest.use).toBe("function");
    expect(typeof ntmTest.describe).toBe("function");
    expect(typeof ntmTest.beforeEach).toBe("function");
  });

  it("re-exports `expect` so a spec needs one import", () => {
    expect(typeof ntmExpect).toBe("function");
    // Playwright's expect, not vitest's — it carries `.soft` and `.configure`.
    expect(typeof ntmExpect.soft).toBe("function");
    expect(typeof ntmExpect.configure).toBe("function");
  });

  it("declares the fixtures on the extended test type", () => {
    // The only runtime-visible proof that `.extend()` ran: `test` is not the
    // same object the peer exports.
    const base = ntmTest.extend({});
    expect(base).not.toBe(ntmTest);
  });
});

/* -------------------------------------------------------------------------- */
/* Watermark                                                                  */
/* -------------------------------------------------------------------------- */

describe("computeWatermark", () => {
  it("floors to the second and subtracts the skew", () => {
    // receivedAt on the wire has one-second granularity, so the sub-second part
    // of a local timestamp is noise that can only discard real mail.
    expect(computeWatermark(1_786_097_700_123, 1_000).getTime()).toBe(1_786_097_699_000);
  });

  it("still floors when the skew is zero", () => {
    expect(computeWatermark(1_786_097_700_999, 0).getTime()).toBe(1_786_097_700_000);
  });

  it("defaults to a one-second skew", () => {
    expect(DEFAULT_WATERMARK_SKEW_MS).toBe(1_000);
    expect(computeWatermark(1_786_097_700_000).getTime()).toBe(1_786_097_699_000);
  });

  it("treats a negative or non-finite skew as zero rather than moving forward", () => {
    expect(computeWatermark(1_786_097_700_000, -5_000).getTime()).toBe(1_786_097_700_000);
    expect(computeWatermark(1_786_097_700_000, Number.NaN).getTime()).toBe(1_786_097_700_000);
  });

  it("never goes below the epoch", () => {
    expect(computeWatermark(500, 1_000).getTime()).toBe(0);
  });
});

describe("applyWatermark", () => {
  const watermark = new Date(1_786_097_690_000);

  it("defaults `after` to the watermark", () => {
    expect(applyWatermark(undefined, watermark).after).toEqual(watermark);
    expect(applyWatermark({}, watermark).after).toEqual(watermark);
  });

  it("leaves an explicit `after` alone", () => {
    const explicit = new Date(1_000_000);
    expect(applyWatermark({ after: explicit }, watermark).after).toBe(explicit);
  });

  it("does not add `after` when ignoreExisting asked for something narrower", () => {
    const resolved = applyWatermark({ ignoreExisting: true }, watermark);
    expect(resolved.ignoreExisting).toBe(true);
    expect(resolved.after).toBeUndefined();
  });

  it("preserves every other filter key and does not mutate the input", () => {
    const input = { subject: "verify", timeoutMs: 5_000 };
    const resolved = applyWatermark(input, watermark);
    expect(resolved.subject).toBe("verify");
    expect(resolved.timeoutMs).toBe(5_000);
    expect(input).not.toHaveProperty("after");
  });
});

/* -------------------------------------------------------------------------- */
/* Trace redaction                                                            */
/* -------------------------------------------------------------------------- */

const RESET_LINK = "https://acme.test/reset?token=SUPERSECRETTOKEN";

const messageWithBody = {
  id: "msg_0001",
  from: "Acme Security <no-reply@acme.test>",
  subject: "Confirm your sign-in",
  receivedAt: new Date(1_786_097_700_000),
  verificationCodes: ["482913"],
  text: `Your code is 482913. Or continue here: ${RESET_LINK}`,
  html: `<a href="${RESET_LINK}">Continue</a>`,
  links: () => [new URL(RESET_LINK)],
};

describe("redactForTrace — redacted by default", () => {
  it("keeps subject, sender, receivedAt and codes", () => {
    const payload = redactForTrace(messageWithBody);
    expect(payload.redacted).toBe(true);
    expect(payload.id).toBe("msg_0001");
    expect(payload.from).toBe("Acme Security <no-reply@acme.test>");
    expect(payload.subject).toBe("Confirm your sign-in");
    expect(payload.receivedAt).toBe(new Date(1_786_097_700_000).toISOString());
    expect(payload.verificationCodes).toEqual(["482913"]);
  });

  it("omits the body and the link, but says how many links there were", () => {
    const payload = redactForTrace(messageWithBody);
    expect(payload.text).toBeUndefined();
    expect(payload.html).toBeUndefined();
    expect(payload.links).toBeUndefined();
    expect(payload.linkCount).toBe(1);
    expect(payload.bodyChars).toBeGreaterThan(0);
  });

  it("keeps the reset link out of the serialised attachment entirely", () => {
    const { body, name, contentType } = traceAttachment(messageWithBody);
    expect(name).toBe("nowtempmail-message.json");
    expect(contentType).toBe("application/json");

    // The whole point: a Playwright trace is a shareable CI artifact.
    expect(body).not.toContain(RESET_LINK);
    expect(body).not.toContain("SUPERSECRETTOKEN");
    expect(body).not.toContain("acme.test/reset");
    expect(body).not.toContain("Your code is 482913. Or continue here");
    expect(body).not.toContain("<a href");

    // ...while still carrying everything needed to debug a wrong match.
    expect(body).toContain("Confirm your sign-in");
    expect(body).toContain("no-reply@acme.test");
    expect(body).toContain("482913");
  });

  it("explains itself in the payload", () => {
    expect(redactForTrace(messageWithBody).note).toMatch(/omitted/i);
    expect(redactForTrace(messageWithBody).note).toContain("attachBody");
  });

  it("notes that waitForCode never fetched a body when there is none", () => {
    const summary = {
      id: "msg_0002",
      from: "GitHub <noreply@github.com>",
      subject: "Verify your device",
      receivedAt: new Date(1_786_097_700_000),
      verificationCodes: ["482913"],
    };
    const payload = redactForTrace(summary);
    expect(payload.linkCount).toBe(0);
    expect(payload.bodyChars).toBe(0);
    expect(payload.note).toMatch(/no body was fetched/i);
  });
});

describe("redactForTrace — attachBody: true", () => {
  it("includes the body, the HTML and the links", () => {
    const payload = redactForTrace(messageWithBody, { attachBody: true });
    expect(payload.redacted).toBe(false);
    expect(payload.text).toContain(RESET_LINK);
    expect(payload.html).toContain("<a href");
    expect(payload.links).toEqual([RESET_LINK]);
  });

  it("puts the link in the serialised attachment and warns about it", () => {
    const { body } = traceAttachment(messageWithBody, { attachBody: true });
    expect(body).toContain("SUPERSECRETTOKEN");
    expect(JSON.parse(body).note).toMatch(/live credential/i);
  });

  it("survives a links() that throws", () => {
    const payload = redactForTrace(
      {
        ...messageWithBody,
        links: () => {
          throw new Error("unparseable");
        },
      },
      { attachBody: true },
    );
    expect(payload.links).toEqual([]);
    expect(payload.linkCount).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* TestInbox — the watermark in action                                        */
/* -------------------------------------------------------------------------- */

describe("TestInbox", () => {
  const NOW_SEC = 1_786_097_700;
  let api: MockApi;
  let client: NowTempMail;
  let mailbox: Mailbox;
  let attachments: Array<{ name: string; body: string }>;
  let ctx: {
    watermark: Date;
    testInfo: TestInfo | null;
    attachBody: boolean;
    watermarkSkewMs: number;
  };

  const fakeTestInfo = (): TestInfo =>
    ({
      attach: async (name: string, opts: { body?: string | Buffer }) => {
        attachments.push({ name, body: String(opts.body ?? "") });
      },
    }) as unknown as TestInfo;

  beforeEach(async () => {
    api = createMockApi();
    client = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    mailbox = await client.mailboxes.create();
    attachments = [];
    ctx = {
      // Ten seconds before "now": the boundary a test that just started would get.
      watermark: new Date((NOW_SEC - 10) * 1000),
      testInfo: fakeTestInfo(),
      attachBody: false,
      watermarkSkewMs: DEFAULT_WATERMARK_SKEW_MS,
    };
  });

  afterEach(() => {
    api.reset();
  });

  it("forwards the address and exposes the watermark", () => {
    const inbox = new TestInbox(mailbox, ctx);
    expect(inbox.address).toBe(mailbox.address);
    expect(inbox.domain).toBe("allogebra.com");
    expect(inbox.watermark).toEqual(ctx.watermark);
    expect(inbox.mailbox).toBe(mailbox);
  });

  it("ignores a code that landed before this test started", async () => {
    // Exactly the shared-inbox failure mode: an earlier test's OTP is still the
    // newest thing in the mailbox.
    api.deliver(mailbox.address, {
      verificationCodes: ["111111"],
      receivedAt: NOW_SEC - 100,
    });
    const inbox = new TestInbox(mailbox, ctx);
    await expect(inbox.waitForCode({ timeoutMs: 120 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("...and the message really was there — only the watermark hid it", async () => {
    api.deliver(mailbox.address, {
      verificationCodes: ["111111"],
      receivedAt: NOW_SEC - 100,
    });
    const inbox = new TestInbox(mailbox, ctx);
    await expect(
      inbox.mailbox.waitForCode({ after: new Date(0), timeoutMs: 120 }),
    ).resolves.toBe("111111");
  });

  it("resolves with the code that landed after the watermark", async () => {
    api.deliver(mailbox.address, {
      verificationCodes: ["111111"],
      receivedAt: NOW_SEC - 100,
    });
    api.deliver(mailbox.address, { verificationCodes: ["222222"], receivedAt: NOW_SEC });
    const inbox = new TestInbox(mailbox, ctx);
    await expect(inbox.waitForCode()).resolves.toBe("222222");
  });

  it("lets an explicit `after` beat the watermark", async () => {
    api.deliver(mailbox.address, {
      verificationCodes: ["111111"],
      receivedAt: NOW_SEC - 100,
    });
    const inbox = new TestInbox(mailbox, ctx);
    await expect(inbox.waitForCode({ after: new Date(0) })).resolves.toBe("111111");
  });

  it("still honours a caller's own match predicate", async () => {
    api.deliver(mailbox.address, {
      subject: "Password reset",
      verificationCodes: ["333333"],
      receivedAt: NOW_SEC,
    });
    api.deliver(mailbox.address, {
      subject: "Sign-in code",
      verificationCodes: ["444444"],
      receivedAt: NOW_SEC,
    });
    const inbox = new TestInbox(mailbox, ctx);
    await expect(
      inbox.waitForCode({ match: (m) => m.subject.includes("Password") }),
    ).resolves.toBe("333333");
  });

  it("attaches the matched message to the report, redacted", async () => {
    api.deliver(mailbox.address, {
      from: "Acme <no-reply@acme.test>",
      subject: "Confirm your sign-in",
      verificationCodes: ["555555"],
      text: `secret body with ${RESET_LINK}`,
      receivedAt: NOW_SEC,
    });
    const inbox = new TestInbox(mailbox, ctx);
    await inbox.waitForCode();

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe("nowtempmail-message.json");
    const payload = JSON.parse(attachments[0]?.body ?? "{}");
    expect(payload.redacted).toBe(true);
    expect(payload.subject).toBe("Confirm your sign-in");
    expect(payload.verificationCodes).toEqual(["555555"]);
    expect(attachments[0]?.body).not.toContain("SUPERSECRETTOKEN");
  });

  it("does not fail the wait when attaching throws", async () => {
    api.deliver(mailbox.address, { verificationCodes: ["666666"], receivedAt: NOW_SEC });
    const inbox = new TestInbox(mailbox, {
      ...ctx,
      testInfo: {
        attach: async () => {
          throw new Error("report is closed");
        },
      } as unknown as TestInfo,
    });
    await expect(inbox.waitForCode()).resolves.toBe("666666");
  });

  it("watermarks waitForMessage too, and attaches the full message redacted", async () => {
    api.deliver(mailbox.address, {
      subject: "Old news",
      verificationCodes: ["777777"],
      receivedAt: NOW_SEC - 100,
    });
    const inbox = new TestInbox(mailbox, ctx);
    await expect(inbox.waitForMessage({ timeoutMs: 120 })).rejects.toMatchObject({
      code: "timeout",
    });

    api.deliver(mailbox.address, {
      subject: "Fresh news",
      text: `body with ${RESET_LINK}`,
      receivedAt: NOW_SEC,
    });
    const message = await inbox.waitForMessage();
    expect(message.subject).toBe("Fresh news");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.body).not.toContain("SUPERSECRETTOKEN");
    expect(JSON.parse(attachments[0]?.body ?? "{}").linkCount).toBe(1);
  });

  it("attaches the body when attachBody opts in", async () => {
    api.deliver(mailbox.address, {
      text: `body with ${RESET_LINK}`,
      receivedAt: NOW_SEC,
    });
    const inbox = new TestInbox(mailbox, { ...ctx, attachBody: true });
    await inbox.waitForMessage();
    expect(attachments[0]?.body).toContain("SUPERSECRETTOKEN");
  });

  it("does nothing when there is no testInfo to attach to", async () => {
    api.deliver(mailbox.address, { verificationCodes: ["888888"], receivedAt: NOW_SEC });
    const inbox = new TestInbox(mailbox, { ...ctx, testInfo: null });
    await expect(inbox.waitForCode()).resolves.toBe("888888");
    expect(attachments).toHaveLength(0);
  });
});
