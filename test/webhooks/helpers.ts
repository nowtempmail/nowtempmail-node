/**
 * Test-only signing helpers.
 *
 * The SDK deliberately exports no signer — its users verify, they never sign —
 * so the sending side lives here. `signHeader()` is an independent
 * transcription of the published signature scheme (see `webhooks:` in
 * https://nowtempmail.com/v1/openapi.json, vendored at spec/openapi.json), not
 * a call back into the SDK's verifier, which is what makes these tests an
 * interop check rather than a round trip against ourselves.
 * `hmacHexViaNodeCrypto()` is an independent oracle: it computes the
 * same digest with node:crypto, so if the transcription and the SDK ever agreed
 * on something wrong, that test would catch it.
 *
 * Nothing here may be imported by anything under src/.
 */

import { createHmac } from "node:crypto";

export const SIGNATURE_VERSION = "v1";

/** A realistic secret. Shape only — this is not a live credential. */
export const SECRET = "whsec_lTsQ2s8FhZqW6nDp1xVbY4uJ3kR7mA0e";

/** 2026-02-14T00:00:00Z, in epoch seconds. Arbitrary but fixed. */
export const T0 = 1_770_940_800;

/** Milliseconds, for the injectable `now`. */
export const NOW = () => T0 * 1000;

/** Exactly what the sender POSTs, serialised once. */
export function eventBody(
  overrides: Record<string, unknown> = {},
  createdAt = T0,
): string {
  return JSON.stringify({
    id: "0f8d3b1a-6c2e-4a55-9d31-7b0c4e2f8a91",
    type: "message.received",
    createdAt,
    data: {
      messageId: "9f2c1c1e-5f2a-4f0b-9f77-1f2a3b4c5d6e",
      address: "crystal482@allogebra.com",
      // Unix MILLISECONDS. Yes, while createdAt above is seconds.
      receivedAt: createdAt * 1000,
    },
    ...overrides,
  });
}

/** The exact string the MAC is taken over. Never drop the `.`. */
export function signedPayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Lowercase hex HMAC-SHA256, via WebCrypto, as the sender does it. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The same digest, computed by a completely different implementation. */
export function hmacHexViaNodeCrypto(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** `v1` digest for a body at a timestamp. */
export function digestFor(
  rawBody: string,
  timestamp = T0,
  secret = SECRET,
): Promise<string> {
  return hmacHex(secret, signedPayload(timestamp, rawBody));
}

/** A ready-to-send `X-NTM-Signature` value, exactly as `signBody` formats it. */
export async function signHeader(
  rawBody: string,
  timestamp = T0,
  secret = SECRET,
): Promise<string> {
  const digest = await digestFor(rawBody, timestamp, secret);
  return `t=${timestamp},${SIGNATURE_VERSION}=${digest}`;
}

/**
 * Sign arbitrary bytes, via node:crypto, so a body that is not valid UTF-8 can
 * still be signed exactly as the sender would sign those same bytes.
 */
export function signHeaderBytes(
  body: Uint8Array,
  timestamp = T0,
  secret = SECRET,
): string {
  const digest = createHmac("sha256", secret)
    .update(Buffer.from(`${timestamp}.`, "utf8"))
    .update(Buffer.from(body))
    .digest("hex");
  return `t=${timestamp},${SIGNATURE_VERSION}=${digest}`;
}

/** 64 hex characters that are not the right 64. */
export const WRONG_DIGEST = "d".repeat(64);
