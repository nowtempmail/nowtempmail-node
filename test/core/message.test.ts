/**
 * Message parsing and attachment download.
 *
 * Every field on a Message came from whoever sent the mail. These tests pin the
 * two places that matters most: the addr-spec parse (a display name is not an
 * address) and attachment download, which returns bytes and never touches the
 * filesystem, because the filename is chosen by the sender.
 */

import { describe, expect, it } from "vitest";
import { MOCK_KEY, createMockApi } from "../helpers/mock-api.js";
import { NowTempMail } from "../../src/client.js";
import { Message } from "../../src/message.js";
import type { WireMessage } from "../../src/types.js";

function wire(overrides: Partial<WireMessage> = {}): WireMessage {
  return {
    id: "9f2c1c1e-5f2a-4f0b-9f77-1f2a3b4c5d6e",
    from: "GitHub <noreply@github.com>",
    to: "crystal482@allogebra.com",
    subject: "[GitHub] Please verify your device",
    receivedAt: 1_786_097_802,
    text: "Your verification code is 482913.",
    html: null,
    verificationCodes: ["482913"],
    attachments: [],
    ...overrides,
  };
}

function build(overrides: Partial<WireMessage> = {}): Message {
  const api = createMockApi();
  const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
  return new Message(ntm.http, "crystal482@allogebra.com", wire(overrides));
}

describe("Message", () => {
  it("converts receivedAt to a Date", () => {
    expect(build().receivedAt.toISOString()).toBe(new Date(1_786_097_802_000).toISOString());
  });

  it("exposes the first code as `code`", () => {
    expect(build().code).toBe("482913");
    expect(build({ verificationCodes: [] }).code).toBeNull();
    expect(build({ verificationCodes: ["a", "b"] }).code).toBe("a");
  });

  it("keeps the raw From header and parses the addr-spec out of it", () => {
    expect(build().from).toBe("GitHub <noreply@github.com>");
    expect(build().fromAddress).toBe("noreply@github.com");
    expect(build({ from: "billing@example.com" }).fromAddress).toBe("billing@example.com");
    expect(build({ from: '"Doe, Jane" <jane@example.com>' }).fromAddress).toBe("jane@example.com");
    expect(build({ from: "  spaced@example.com  " }).fromAddress).toBe("spaced@example.com");
    // Nothing usable rather than a guess: a display name is not an address.
    expect(build({ from: "Support Team" }).fromAddress).toBeNull();
    expect(build({ from: "" }).fromAddress).toBeNull();
    expect(build({ from: "<not an address>" }).fromAddress).toBeNull();
  });

  it("does not mutate the caller's arrays", () => {
    const codes = ["482913"];
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    const message = new Message(ntm.http, "a@b.com", wire({ verificationCodes: codes }));
    message.verificationCodes.push("nope");
    expect(codes).toEqual(["482913"]);
  });
});

describe("Message.links()", () => {
  it("pulls URLs from text and html, deduped and in order", () => {
    const message = build({
      text: "Verify at https://example.com/verify?t=1 then read https://example.com/help.",
      html: '<a href="https://example.com/verify?t=1">verify</a> <a href="https://other.test/x">x</a>',
    });
    expect(message.links().map((u) => u.href)).toEqual([
      "https://example.com/verify?t=1",
      "https://example.com/help",
      "https://other.test/x",
    ]);
  });

  it("strips the punctuation a sentence leaves stuck to a URL", () => {
    const message = build({
      text: "Go to https://example.com/a, or https://example.com/b. Maybe (https://example.com/c)",
      html: null,
    });
    expect(message.links().map((u) => u.pathname)).toEqual(["/a", "/b", "/c"]);
  });

  it("decodes the entities an html href actually contains", () => {
    const message = build({
      text: null,
      html: '<a href="https://example.com/r?a=1&amp;b=2">click</a>',
    });
    expect(message.links().map((u) => u.href)).toEqual(["https://example.com/r?a=1&b=2"]);
  });

  it("returns an empty list when there is nothing to find", () => {
    expect(build({ text: "no links here", html: null }).links()).toEqual([]);
    expect(build({ text: null, html: null }).links()).toEqual([]);
  });

  it("ignores non-http schemes, including javascript:", () => {
    const message = build({
      text: "mailto:someone@example.com javascript:alert(1) ftp://example.com/x",
      html: null,
    });
    expect(message.links()).toEqual([]);
  });
});

describe("Attachment", () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);

  async function deliverWithAttachment(filename: string) {
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    const mailbox = await ntm.mailboxes.create();
    const stored = api.deliver(mailbox.address, {
      subject: "Your invoice",
      attachments: [{ filename, contentType: "application/pdf", bytes }],
    });
    const message = await mailbox.messages.get(stored.id);
    return { api, message };
  }

  it("returns the exact bytes", async () => {
    const { message } = await deliverWithAttachment("invoice-2026-08.pdf");
    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments[0]!;
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.size).toBe(bytes.byteLength);

    const downloaded = await attachment.download();
    expect(downloaded.bytes).toBeInstanceOf(Uint8Array);
    expect(downloaded.bytes.byteLength).toBe(bytes.byteLength);
    expect(Array.from(downloaded.bytes)).toEqual(Array.from(bytes));
    expect(downloaded.contentType).toBe("application/pdf");
  });

  it("hands back the sender's filename verbatim, without ever writing it", async () => {
    // A path traversal in a filename is a routine thing to receive. The SDK's
    // job is to not act on it: bytes in memory, name untouched, no fs call.
    const hostile = "../../../etc/passwd";
    const { message } = await deliverWithAttachment(hostile);
    const downloaded = await message.attachments[0]!.download();
    expect(downloaded.filename).toBe(hostile);
    expect(Array.from(downloaded.bytes)).toEqual(Array.from(bytes));
  });

  it("404s on an attachment that is no longer stored", async () => {
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    const mailbox = await ntm.mailboxes.create();
    const stored = api.deliver(mailbox.address, {
      attachments: [{ filename: "a.txt", contentType: "text/plain", bytes }],
    });
    const message = await mailbox.messages.get(stored.id);
    await mailbox.messages.delete(stored.id);
    await expect(message.attachments[0]!.download()).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
