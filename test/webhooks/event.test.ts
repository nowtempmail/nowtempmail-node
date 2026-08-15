/**
 * What verifyWebhook() returns once the bytes are authentic, and how it refuses
 * bodies that verify but are not the event we send.
 *
 * The dividing line under test: an authentic-but-malformed body is a
 * WebhookSignatureError (respond 400, do not process), never a TypeError from
 * reaching into `undefined`.
 */

import { describe, expect, it } from "vitest";

import {
  isValidWebhookSignature,
  verifyWebhook,
} from "../../src/webhooks/index.js";
import {
  NOW,
  SECRET,
  T0,
  eventBody,
  signHeader,
  signHeaderBytes,
} from "./helpers.js";

async function verify(rawBody: string) {
  return verifyWebhook({
    rawBody,
    signature: await signHeader(rawBody),
    secret: SECRET,
    now: NOW,
  });
}

async function failureMessage(rawBody: string): Promise<string> {
  try {
    await verify(rawBody);
  } catch (err) {
    expect((err as { code?: string }).code).toBe("webhook_signature");
    return (err as Error).message;
  }
  throw new Error("expected verifyWebhook to reject, but it resolved");
}

/* -------------------------------------------------------------------------- */

describe("the returned event", () => {
  it("converts createdAt from epoch seconds and receivedAt from epoch milliseconds", async () => {
    // The unit asymmetry is in the API spec: createdAt is seconds (it is the
    // same value as `t` in the signature), data.receivedAt is milliseconds.
    const body = JSON.stringify({
      id: "0f8d3b1a-6c2e-4a55-9d31-7b0c4e2f8a91",
      type: "message.received",
      createdAt: 1786097802,
      data: {
        messageId: "9f2c1c1e-5f2a-4f0b-9f77-1f2a3b4c5d6e",
        address: "crystal482@allogebra.com",
        receivedAt: 1786097802000,
      },
    });

    const event = await verifyWebhook({
      rawBody: body,
      signature: await signHeader(body, 1786097802),
      secret: SECRET,
      now: () => 1786097802000,
    });

    expect(event.createdAt).toBeInstanceOf(Date);
    expect(event.data.receivedAt).toBeInstanceOf(Date);
    expect(event.createdAt.toISOString()).toBe("2026-08-07T10:16:42.000Z");
    expect(event.data.receivedAt.toISOString()).toBe("2026-08-07T10:16:42.000Z");
  });

  it("returns exactly the documented public shape", async () => {
    const event = await verify(eventBody());
    expect(Object.keys(event).sort()).toEqual([
      "createdAt",
      "data",
      "id",
      "type",
    ]);
    expect(Object.keys(event.data).sort()).toEqual([
      "address",
      "messageId",
      "receivedAt",
    ]);
  });

  it("drops unknown members rather than leaking wire-only fields", async () => {
    // POST /v1/webhooks/test adds members the public type does not carry.
    const body = JSON.stringify({
      id: "2c9a7f30-1b64-4d0e-8a52-3f7d1c6b9e04",
      type: "message.received",
      createdAt: T0,
      deliberate: true,
      somethingNew: { nested: 1 },
      data: {
        messageId: "test_8Kd2mQx7Rp4Lv9Nb",
        address: "test@allogebra.com",
        receivedAt: T0 * 1000,
        extra: "ignored",
      },
    });

    const event = await verify(body);
    expect(event).not.toHaveProperty("deliberate");
    expect(event).not.toHaveProperty("somethingNew");
    expect(event.data).not.toHaveProperty("extra");
    expect(event.data.messageId).toBe("test_8Kd2mQx7Rp4Lv9Nb");
  });

  it("passes an unrecognised type through instead of rejecting it", async () => {
    // Forward compatibility: a second event type must not break existing
    // installs. Callers switch on `type` and reject what they do not know.
    const body = JSON.stringify({
      id: "d1",
      type: "message.bounced",
      createdAt: T0,
      data: { messageId: "m1", address: "a@b.com", receivedAt: T0 * 1000 },
    });

    const event = await verify(body);
    expect(event.type as string).toBe("message.bounced");
  });
});

/* -------------------------------------------------------------------------- */

describe("authentic bytes that are not our event", () => {
  it("rejects a body that is not JSON at all", async () => {
    const message = await failureMessage("this is not json");
    expect(message).toMatch(/not valid JSON/);
  });

  it("rejects a truncated JSON body", async () => {
    const message = await failureMessage(eventBody().slice(0, 40));
    expect(message).toMatch(/not valid JSON/);
  });

  it("rejects an empty body", async () => {
    const message = await failureMessage("");
    expect(message).toMatch(/not valid JSON/);
  });

  it("rejects valid JSON that is not an object", async () => {
    for (const body of ['"a string"', "42", "null", "true", "[]"]) {
      const message = await failureMessage(body);
      expect(message).toMatch(/not a JSON object/);
    }
  });

  const missing: Array<[string, unknown]> = [
    ["id", { type: "message.received", createdAt: T0 }],
    ["type", { id: "d1", createdAt: T0 }],
    ["createdAt", { id: "d1", type: "message.received" }],
  ];

  for (const [name, partial] of missing) {
    it(`rejects a payload missing ${name}`, async () => {
      const body = JSON.stringify({
        ...(partial as Record<string, unknown>),
        data: { messageId: "m1", address: "a@b.com", receivedAt: T0 * 1000 },
      });
      const message = await failureMessage(body);
      expect(message).toContain(`\`${name}\``);
    });
  }

  it("rejects a payload with no data member", async () => {
    const body = JSON.stringify({ id: "d1", type: "message.received", createdAt: T0 });
    const message = await failureMessage(body);
    expect(message).toMatch(/`data` is not a JSON object/);
  });

  const badData: Array<[string, Record<string, unknown>]> = [
    ["data.messageId", { address: "a@b.com", receivedAt: T0 * 1000 }],
    ["data.address", { messageId: "m1", receivedAt: T0 * 1000 }],
    ["data.receivedAt", { messageId: "m1", address: "a@b.com" }],
  ];

  for (const [name, data] of badData) {
    it(`rejects a payload missing ${name}`, async () => {
      const body = JSON.stringify({
        id: "d1",
        type: "message.received",
        createdAt: T0,
        data,
      });
      const message = await failureMessage(body);
      expect(message).toContain(`\`${name}\``);
    });
  }

  it("rejects a createdAt that is a string, even a numeric one", async () => {
    const body = JSON.stringify({
      id: "d1",
      type: "message.received",
      createdAt: String(T0),
      data: { messageId: "m1", address: "a@b.com", receivedAt: T0 * 1000 },
    });
    const message = await failureMessage(body);
    expect(message).toMatch(/`createdAt` must be a finite number/);
  });

  it("rejects an empty-string id", async () => {
    const body = JSON.stringify({
      id: "",
      type: "message.received",
      createdAt: T0,
      data: { messageId: "m1", address: "a@b.com", receivedAt: T0 * 1000 },
    });
    const message = await failureMessage(body);
    expect(message).toMatch(/`id` must be a non-empty string/);
  });

  it("rejects a null data member without dereferencing it", async () => {
    const body = JSON.stringify({
      id: "d1",
      type: "message.received",
      createdAt: T0,
      data: null,
    });
    const message = await failureMessage(body);
    expect(message).toMatch(/`data` is not a JSON object/);
  });

  it("says the signature verified, so the reader knows where to look", async () => {
    const message = await failureMessage("not json");
    expect(message).toMatch(/signature verified/);
  });

  it("rejects an authentically signed body that is not valid UTF-8", async () => {
    // A lone 0x80 is a continuation byte and cannot start a sequence, so a
    // fatal TextDecoder throws on it. These bytes are genuinely signed, which
    // is the only way to reach the decode branch at all.
    const bytes = new Uint8Array([0x7b, 0x80, 0x7d]);

    let message = "";
    try {
      await verifyWebhook({
        rawBody: bytes,
        signature: signHeaderBytes(bytes),
        secret: SECRET,
        now: NOW,
      });
      throw new Error("expected verifyWebhook to reject, but it resolved");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("webhook_signature");
      message = (err as Error).message;
    }
    expect(message).toMatch(/not valid UTF-8/);

    // The bytes really were authentic — the failure is about the content only.
    await expect(
      isValidWebhookSignature({
        rawBody: bytes,
        signature: signHeaderBytes(bytes),
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("isValidWebhookSignature vs verifyWebhook", () => {
  it("accepts an authentic non-JSON body — it only judges the bytes", async () => {
    const body = "plain text, correctly signed";
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);

    // The same input through verifyWebhook is a signature error.
    expect(await failureMessage(body)).toMatch(/not valid JSON/);
  });
});
