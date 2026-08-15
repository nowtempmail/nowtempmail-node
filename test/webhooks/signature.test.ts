/**
 * Signature verification: config refusal, header grammar, replay window,
 * tamper detection, body encodings.
 *
 * Every signature in here is produced by test/webhooks/helpers.ts, which is an
 * independent transcription of the published signature scheme rather than a
 * call back into the verifier. That is what makes these interop tests: if the
 * SDK's verifier and the scheme it must accept ever diverge, these fail.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isValidWebhookSignature,
  verifyWebhook,
} from "../../src/webhooks/index.js";
import {
  NOW,
  SECRET,
  T0,
  WRONG_DIGEST,
  digestFor,
  eventBody,
  hmacHex,
  hmacHexViaNodeCrypto,
  signHeader,
  signedPayload,
} from "./helpers.js";

/** Assert an error's `code` rather than its class — dual-package hazard. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? "(no code)";
  }
  throw new Error("expected the call to reject, but it resolved");
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the call to reject, but it resolved");
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe("a valid signature", () => {
  it("verifies and returns the event", async () => {
    const body = eventBody();
    const event = await verifyWebhook({
      rawBody: body,
      signature: await signHeader(body),
      secret: SECRET,
      now: NOW,
    });

    expect(event.id).toBe("0f8d3b1a-6c2e-4a55-9d31-7b0c4e2f8a91");
    expect(event.type).toBe("message.received");
  });

  it("agrees with an independent HMAC implementation (node:crypto)", async () => {
    const body = eventBody();
    const viaWebCrypto = await hmacHex(SECRET, signedPayload(T0, body));
    const viaNode = hmacHexViaNodeCrypto(SECRET, signedPayload(T0, body));

    expect(viaWebCrypto).toBe(viaNode);
    expect(viaWebCrypto).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${viaNode}`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("is what a caller gets from isValidWebhookSignature", async () => {
    const body = eventBody();
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("secret refusal (the most important behaviour in the module)", () => {
  /**
   * Proof, not vibes: spy on WebCrypto and assert it was never touched. A
   * verifier that imports a zero-length key and then rejects everything would
   * pass a "it throws" test while being exactly the bug we are guarding.
   */
  async function expectNoCryptoWork(
    call: () => Promise<unknown>,
  ): Promise<string> {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const sign = vi.spyOn(crypto.subtle, "sign");
    const parse = vi.spyOn(JSON, "parse");

    const code = await codeOf(call());

    expect(code).toBe("webhook_config");
    expect(importKey).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    return code;
  }

  const body = eventBody();
  const goodHeader = `t=${T0},v1=${WRONG_DIGEST}`;

  it("refuses an empty-string secret before computing any HMAC", async () => {
    await expectNoCryptoWork(() =>
      verifyWebhook({
        rawBody: body,
        signature: goodHeader,
        secret: "",
        now: NOW,
      }),
    );
  });

  it("refuses a whitespace-only secret before computing any HMAC", async () => {
    await expectNoCryptoWork(() =>
      verifyWebhook({
        rawBody: body,
        signature: goodHeader,
        secret: "   \t\n ",
        now: NOW,
      }),
    );
  });

  it("refuses an undefined secret before computing any HMAC", async () => {
    await expectNoCryptoWork(() =>
      verifyWebhook({
        rawBody: body,
        signature: goodHeader,
        // The realistic shape of this bug: process.env.X is undefined.
        secret: undefined as unknown as string,
        now: NOW,
      }),
    );
  });

  it("refuses a non-string secret", async () => {
    expect(
      await codeOf(
        verifyWebhook({
          rawBody: body,
          signature: goodHeader,
          secret: { toString: () => "whsec_x" } as unknown as string,
          now: NOW,
        }),
      ),
    ).toBe("webhook_config");
  });

  it("still throws from isValidWebhookSignature — never a silent false", async () => {
    expect(
      await codeOf(
        isValidWebhookSignature({
          rawBody: body,
          signature: goodHeader,
          secret: "",
          now: NOW,
        }),
      ),
    ).toBe("webhook_config");
  });

  it("mentions the unset environment variable, since that is the cause", async () => {
    const message = await messageOf(
      verifyWebhook({
        rawBody: body,
        signature: goodHeader,
        secret: "",
        now: NOW,
      }),
    );
    expect(message).toMatch(/environment variable/i);
  });
});

/* -------------------------------------------------------------------------- */

describe("other misconfiguration", () => {
  const body = eventBody();

  it("refuses a NaN tolerance, which would silently disable the replay window", async () => {
    expect(
      await codeOf(
        verifyWebhook({
          rawBody: body,
          signature: await signHeader(body),
          secret: SECRET,
          toleranceSeconds: Number.NaN,
          now: NOW,
        }),
      ),
    ).toBe("webhook_config");
  });

  it("refuses a negative tolerance", async () => {
    expect(
      await codeOf(
        verifyWebhook({
          rawBody: body,
          signature: await signHeader(body),
          secret: SECRET,
          toleranceSeconds: -1,
          now: NOW,
        }),
      ),
    ).toBe("webhook_config");
  });

  it("refuses an already-parsed body and says why", async () => {
    const message = await messageOf(
      verifyWebhook({
        rawBody: JSON.parse(body) as unknown as string,
        signature: await signHeader(body),
        secret: SECRET,
        now: NOW,
      }),
    );
    expect(message).toMatch(/Webhook verifier misconfigured/);
    expect(message).toMatch(/raw bytes|rawBody/);
  });

  it("refuses a now() that does not return a number", async () => {
    expect(
      await codeOf(
        verifyWebhook({
          rawBody: body,
          signature: await signHeader(body),
          secret: SECRET,
          now: (() => new Date()) as unknown as () => number,
        }),
      ),
    ).toBe("webhook_config");
  });
});

/* -------------------------------------------------------------------------- */

describe("header parsing", () => {
  const body = eventBody();

  it("tolerates whitespace around names and values", async () => {
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `  t = ${T0} ,  v1 = ${digest}  `,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("tolerates an unknown v2 scheme, so a digest migration is not breaking", async () => {
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${digest},v2=someFutureDigest==`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("ignores unknown schemes even when they come first", async () => {
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `v2=whatever,t=${T0},v0=legacy,v1=${digest}`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("accepts when any v1 matches — including when the match is last", async () => {
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${WRONG_DIGEST},v1=${"a".repeat(64)},v1=${digest}`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("accepts when the match is first, with junk after it", async () => {
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${digest},v1=${WRONG_DIGEST}`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("rejects when no v1 matches, however many are offered", async () => {
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${WRONG_DIGEST},v1=${"a".repeat(64)}`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("accepts the header as an array, as Node's req.headers can give it", async () => {
    const header = await signHeader(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: [header],
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("joins a split array of header lines with a comma", async () => {
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: [`t=${T0}`, `v1=${digest}`],
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("only splits each part at its first '=', so a padded value survives", async () => {
    // Not a real digest, just proof the parser does not lose the tail.
    const message = await messageOf(
      verifyWebhook({
        rawBody: body,
        signature: `t=${T0},v1=abc==`,
        secret: SECRET,
        now: NOW,
      }),
    );
    expect(message).toMatch(/candidate matched/);
  });

  const rejected: Array<[string, string | string[] | null | undefined]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["empty array", []],
    ["garbage with no pairs", "not-a-signature"],
    ["no t component", `v1=${WRONG_DIGEST}`],
    ["unparseable t", `t=later,v1=${WRONG_DIGEST}`],
    ["no v1 component", `t=${T0}`],
    ["t and nothing else parseable", `t=${T0},garbage`],
    ["semicolons instead of commas", `t=${T0};v1=${WRONG_DIGEST}`],
  ];

  for (const [label, signature] of rejected) {
    it(`rejects ${label} as a signature error, not a crash`, async () => {
      expect(
        await codeOf(
          verifyWebhook({ rawBody: body, signature, secret: SECRET, now: NOW }),
        ),
      ).toBe("webhook_signature");

      await expect(
        isValidWebhookSignature({
          rawBody: body,
          signature,
          secret: SECRET,
          now: NOW,
        }),
      ).resolves.toBe(false);
    });
  }

  it("does not echo an oversized header back in full", async () => {
    const message = await messageOf(
      verifyWebhook({
        rawBody: body,
        signature: "x".repeat(5000),
        secret: SECRET,
        now: NOW,
      }),
    );
    expect(message.length).toBeLessThan(500);
  });
});

/* -------------------------------------------------------------------------- */

describe("the replay window", () => {
  const body = eventBody();
  const at = (seconds: number) => () => seconds * 1000;

  it("accepts a timestamp exactly at the tolerance in the past", async () => {
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        now: at(T0 + 300),
      }),
    ).resolves.toBe(true);
  });

  it("accepts a timestamp exactly at the tolerance in the future", async () => {
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        now: at(T0 - 300),
      }),
    ).resolves.toBe(true);
  });

  it("rejects one second past the tolerance (expired)", async () => {
    expect(
      await codeOf(
        verifyWebhook({
          rawBody: body,
          signature: await signHeader(body),
          secret: SECRET,
          now: at(T0 + 301),
        }),
      ),
    ).toBe("webhook_signature");
  });

  it("rejects one second past the tolerance in the future — the check is symmetric", async () => {
    // A receiver whose clock runs slow must not become a replay oracle.
    expect(
      await codeOf(
        verifyWebhook({
          rawBody: body,
          signature: await signHeader(body),
          secret: SECRET,
          now: at(T0 - 301),
        }),
      ),
    ).toBe("webhook_signature");
  });

  it("states the actual skew in seconds, because clock drift is the usual cause", async () => {
    const message = await messageOf(
      verifyWebhook({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        now: at(T0 + 412),
      }),
    );
    expect(message).toContain("412s");
    expect(message).toContain("in the past");
    expect(message).toContain("300s tolerance");
    expect(message).toMatch(/clock/i);
  });

  it("says 'in the future' when the timestamp is ahead of us", async () => {
    const message = await messageOf(
      verifyWebhook({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        now: at(T0 - 500),
      }),
    );
    expect(message).toContain("500s");
    expect(message).toContain("in the future");
  });

  it("honours a widened tolerance", async () => {
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        toleranceSeconds: 86_400,
        now: at(T0 + 3600),
      }),
    ).resolves.toBe(true);
  });

  it("honours a tightened tolerance", async () => {
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body),
        secret: SECRET,
        toleranceSeconds: 5,
        now: at(T0 + 6),
      }),
    ).resolves.toBe(false);
  });

  it("rejects on tolerance without computing an HMAC — the cheap check is first", async () => {
    // Sign first: the spy must only observe the call under test.
    const header = await signHeader(body);
    const sign = vi.spyOn(crypto.subtle, "sign");

    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: header,
        secret: SECRET,
        now: at(T0 + 10_000),
      }),
    ).resolves.toBe(false);
    expect(sign).not.toHaveBeenCalled();
  });

  it("defaults to the current clock when now is omitted", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body, nowSeconds),
        secret: SECRET,
      }),
    ).resolves.toBe(true);

    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body, nowSeconds - 4000),
        secret: SECRET,
      }),
    ).resolves.toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("tampering", () => {
  it("rejects a modified body", async () => {
    const body = eventBody();
    const header = await signHeader(body);
    const tampered = body.replace(
      "crystal482@allogebra.com",
      "attacker@evil.example",
    );
    expect(tampered).not.toBe(body);

    expect(
      await codeOf(
        verifyWebhook({
          rawBody: tampered,
          signature: header,
          secret: SECRET,
          now: NOW,
        }),
      ),
    ).toBe("webhook_signature");
  });

  it("rejects a single appended byte", async () => {
    const body = eventBody();
    const header = await signHeader(body);
    await expect(
      isValidWebhookSignature({
        rawBody: `${body} `,
        signature: header,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  /**
   * The load-bearing test for replay protection: take a signature that is
   * genuinely valid at t1, re-present the same body with a fresh t2 that is
   * comfortably inside the tolerance, and it must still fail. It only fails if
   * the timestamp is inside the MAC.
   */
  it("rejects a valid digest re-presented under a different timestamp", async () => {
    const body = eventBody();
    const t1 = T0;
    const t2 = T0 + 120;
    const digestForT1 = await digestFor(body, t1);

    // Sanity: it really is valid at t1.
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${t1},v1=${digestForT1}`,
        secret: SECRET,
        now: () => t1 * 1000,
      }),
    ).resolves.toBe(true);

    const message = await messageOf(
      verifyWebhook({
        rawBody: body,
        signature: `t=${t2},v1=${digestForT1}`,
        secret: SECRET,
        // Inside tolerance for t2, so this cannot be a tolerance rejection.
        now: () => t2 * 1000,
      }),
    );
    expect(message).toMatch(/candidate matched/);
  });

  it("rejects a signature made with a different secret", async () => {
    const body = eventBody();
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: await signHeader(body, T0, "whsec_someOtherKeysSecret"),
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an uppercase digest, matching the signer's lowercase hex exactly", async () => {
    const body = eventBody();
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${digest.toUpperCase()}`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a truncated digest", async () => {
    const body = eventBody();
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${digest.slice(0, 32)}`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a digest with trailing padding", async () => {
    const body = eventBody();
    const digest = await digestFor(body);
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=${digest}00`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an empty v1 value", async () => {
    const body = eventBody();
    await expect(
      isValidWebhookSignature({
        rawBody: body,
        signature: `t=${T0},v1=`,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an empty body against a signature over a real one", async () => {
    const body = eventBody();
    await expect(
      isValidWebhookSignature({
        rawBody: "",
        signature: await signHeader(body),
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("body encodings", () => {
  it("verifies identically as a string, a Uint8Array and an ArrayBuffer", async () => {
    const body = eventBody();
    const header = await signHeader(body);
    const bytes = new TextEncoder().encode(body);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    const results = await Promise.all(
      [body, bytes, buffer].map((rawBody) =>
        verifyWebhook({ rawBody, signature: header, secret: SECRET, now: NOW }),
      ),
    );

    expect(results).toHaveLength(3);
    for (const event of results) {
      expect(event.id).toBe("0f8d3b1a-6c2e-4a55-9d31-7b0c4e2f8a91");
      expect(event.data.address).toBe("crystal482@allogebra.com");
      expect(event.createdAt.getTime()).toBe(T0 * 1000);
    }
  });

  it("verifies a Node Buffer (a Uint8Array view with a byte offset)", async () => {
    const body = eventBody();
    const header = await signHeader(body);
    // A pooled Buffer shares one backing ArrayBuffer, so a verifier that reads
    // `.buffer` without honouring byteOffset hashes its neighbours' bytes.
    const padded = Buffer.concat([Buffer.from("XXXX"), Buffer.from(body, "utf8")]);
    const view = padded.subarray(4);
    expect(view.byteOffset).toBeGreaterThan(0);
    expect(view.toString("utf8")).toBe(body);

    await expect(
      isValidWebhookSignature({
        rawBody: view,
        signature: header,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("handles non-ASCII bodies byte-for-byte", async () => {
    const body = JSON.stringify({
      id: "d1",
      type: "message.received",
      createdAt: T0,
      data: {
        messageId: "m1",
        address: "café@allogebra.com",
        receivedAt: T0 * 1000,
        note: "naïve — 日本語 — 🎯",
      },
    });
    const header = await signHeader(body);

    const event = await verifyWebhook({
      rawBody: new TextEncoder().encode(body),
      signature: header,
      secret: SECRET,
      now: NOW,
    });
    expect(event.data.address).toBe("café@allogebra.com");
  });

  it("verifies a body whose escaping differs, proving raw bytes are what count", async () => {
    // Semantically identical JSON, different bytes: the digest is over bytes.
    const body = eventBody();
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(reserialised).not.toBe(body);

    const header = await signHeader(body);
    await expect(
      isValidWebhookSignature({
        rawBody: reserialised,
        signature: header,
        secret: SECRET,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });
});
