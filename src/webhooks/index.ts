/**
 * Webhook signature verification.
 *
 * This module is the receiving half of the signature scheme published under
 * `webhooks:` in the OpenAPI document (https://nowtempmail.com/v1/openapi.json,
 * vendored at spec/openapi.json). It must accept exactly what the sender
 * produces and nothing else: same header grammar, same signed payload, same
 * symmetric tolerance, same length-independent compare. Changing any of those
 * four is a breaking change for every deployed receiver, not a cleanup.
 *
 * The scheme is Stripe's, on purpose:
 *
 *     X-NTM-Signature: t=<unix seconds>,v1=<lowercase hex hmac-sha256>
 *     signed payload  = `${t}.${rawBody}`
 *     key             = your per-key webhook signing secret (whsec_...)
 *
 * Four properties of this file are load-bearing. Each is here because getting
 * it wrong produces a verifier that looks like it works.
 *
 * 1. **A blank secret is refused before any HMAC is computed.** WebCrypto will
 *    happily import a zero-length key, and `String(undefined)` is a perfectly
 *    good key too. Either way you get a verifier that computes *some* digest
 *    and rejects real traffic - or, if the sender is misconfigured in the same
 *    way, one that accepts forgeries. No test written against a real signature
 *    would ever notice. So: `WebhookConfigError`, first thing, always.
 * 2. **The timestamp is inside the MAC.** `${t}.${rawBody}`, never `t + body`
 *    and never the body alone. That is the whole of the replay protection: a
 *    captured body cannot be re-presented with a fresh `t`, because changing
 *    `t` invalidates the digest.
 * 3. **The tolerance check is symmetric.** `|now - t| > tolerance` rejects a
 *    future-dated timestamp as well as a stale one. A receiver whose clock runs
 *    slow would otherwise accept arbitrarily old replays.
 * 4. **Every `v1` candidate is compared, in constant time, with no early
 *    exit.** A short-circuiting compare leaks how many leading hex characters
 *    were right; a short-circuiting *loop* leaks which candidate matched.
 *
 * Zero dependencies, `crypto.subtle` only - never `node:crypto`. A webhook
 * receiver is exactly the kind of endpoint people put on an edge runtime, so
 * this module has to run unchanged on Node, Bun, Deno and Cloudflare Workers -
 * and on Workers there is no `node:crypto` to fall back to.
 *
 * @module
 */

import {
  NowTempMailError,
  WebhookConfigError,
  WebhookSignatureError,
} from "../errors.js";
import type { WebhookEvent } from "../types.js";

export { WebhookConfigError, WebhookSignatureError };
/**
 * Re-exported so this entry point is usable on its own.
 *
 * A webhook receiver typically has no reason to construct a client, but it does
 * need `NowTempMailError.is()` and `.toLogString()` to handle what this module
 * throws. Without this, every receiver would have to import the root entry —
 * pulling in the whole client — just to branch on an error.
 */
export { NowTempMailError };
export type { WebhookEvent };

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface VerifyWebhookOptions {
  /**
   * The **exact bytes** of the request body, read before any JSON parse.
   *
   * A `string` is accepted and is assumed to be UTF-8. Prefer the raw bytes
   * where your framework gives you the choice (`express.raw()`,
   * `await request.arrayBuffer()`, `req.rawBody`), because the single most
   * common cause of a mismatch that is not clock skew is verifying a
   * re-serialised body: we serialise once and sign and send that identical
   * string, and a round trip through your JSON library can change escaping
   * without changing meaning. `JSON.stringify(req.body)` will not verify.
   */
  rawBody: Uint8Array | ArrayBuffer | string;
  /**
   * The `X-NTM-Signature` header. An array is accepted because Node's
   * `req.headers` can hand you one; its elements are joined with `,`, which is
   * what RFC 9110 says repeated field lines mean.
   */
  signature: string | string[] | null | undefined;
  /** Your per-key webhook signing secret, `whsec_...`. */
  secret: string;
  /** Replay window, seconds, applied symmetrically. Default 300. */
  toleranceSeconds?: number;
  /** Injectable clock in epoch milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Verify a webhook request and return the parsed event.
 *
 * The signature is checked **before** the body is parsed - an unverified body
 * is attacker-controlled input and must not reach your JSON parser, let alone
 * your handler.
 *
 * Dates: `createdAt` comes off the wire as epoch **seconds** (it is the same
 * value as `t` in the signature) and `data.receivedAt` as epoch
 * **milliseconds**. That asymmetry is in the API spec, not a bug here; both
 * arrive as `Date` so callers never have to know.
 *
 * @throws {WebhookConfigError} Missing or blank `secret`, an unusable
 * `toleranceSeconds`/`now`, a `rawBody` that is not bytes or a string, or an
 * environment without WebCrypto. These are your bugs, not the sender's.
 * @throws {WebhookSignatureError} Anything about the request itself: no header,
 * an unreadable header, a timestamp outside the tolerance, no matching digest,
 * or a verified body that is not the JSON event we send. Respond `400` and do
 * not process the body.
 */
export async function verifyWebhook(
  o: VerifyWebhookOptions,
): Promise<WebhookEvent> {
  const body = await verifiedBody(o);
  return eventFromBytes(body);
}

/**
 * Verify without parsing.
 *
 * Returns `false` for every problem with the request - missing header, bad
 * digest, stale timestamp - so a handler that only needs to decide 200 vs 400
 * does not need a `try`/`catch`. Misconfiguration still throws
 * `WebhookConfigError`: a blank secret is not "signature invalid", it is a
 * verifier that is not verifying anything, and silently returning `false`
 * there would hide exactly the bug this module exists to prevent.
 *
 * Note that this says nothing about the body being valid JSON - only that the
 * bytes are authentic. Use {@link verifyWebhook} if you want the event.
 */
export async function isValidWebhookSignature(
  o: VerifyWebhookOptions,
): Promise<boolean> {
  try {
    await verifiedBody(o);
    return true;
  } catch (err) {
    // Branch on `code`, never `instanceof`: this package is dual-published and
    // a consumer can hold two copies of the error classes at once.
    if (NowTempMailError.is(err) && err.code === "webhook_signature") {
      return false;
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Mirrors `SIGNATURE_VERSION` on the signing side. Only `v1` is understood. */
const SIGNATURE_VERSION = "v1";

/** Stripe's default, and the sender's. Five minutes bounds replay. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/** Named only so error messages can say which header they mean. */
const SIGNATURE_HEADER = "X-NTM-Signature";

/** Keeps a hostile 2MB header out of an error message and out of your logs. */
const HEADER_EXCERPT_CHARS = 120;

const ENCODER = new TextEncoder();

/**
 * A byte view over a real `ArrayBuffer`.
 *
 * Spelled out rather than left as bare `Uint8Array` because `BufferSource` -
 * what `crypto.subtle.sign` accepts - excludes `SharedArrayBuffer`-backed
 * views, and a `Buffer`'s `.buffer` is typed `ArrayBufferLike`. Normalising
 * once in `toBytes` keeps the cast at the boundary instead of at the crypto
 * call.
 */
type Bytes = Uint8Array<ArrayBuffer>;

interface ResolvedOptions {
  secret: string;
  toleranceSeconds: number;
  nowSeconds: number;
  body: Bytes;
}

/**
 * Config validation, in full, before a single byte is hashed.
 *
 * Everything here throws `WebhookConfigError`, and everything here is checked
 * eagerly rather than lazily, because the failure mode of each of these is a
 * verifier that appears to work:
 *
 * - a blank secret keys the MAC with nothing;
 * - `toleranceSeconds: NaN` makes `Math.abs(skew) > NaN` false, which disables
 *   the replay window entirely and silently;
 * - a `rawBody` that is not bytes would stringify to `[object Object]`, which
 *   hashes fine and never matches.
 */
function resolveOptions(o: VerifyWebhookOptions): ResolvedOptions {
  if (o === null || typeof o !== "object") {
    throw new WebhookConfigError("verifyWebhook requires an options object.");
  }

  // Rule one. Nothing above this line may compute anything.
  const { secret } = o;
  if (secret === undefined || secret === null) {
    throw new WebhookConfigError(
      "no `secret` was supplied. Pass your per-key webhook signing secret " +
        "(whsec_...); it is shown once when you create the key and is readable " +
        "from your dashboard. Verifying with an absent secret cannot fail " +
        "safely, so this refuses instead of guessing. Check the environment " +
        "variable holding it is actually reaching this process.",
    );
  }
  if (typeof secret !== "string") {
    throw new WebhookConfigError(
      `\`secret\` must be a string, received ${typeof secret}.`,
    );
  }
  if (secret.trim() === "") {
    throw new WebhookConfigError(
      "`secret` is empty or whitespace-only. This is usually an unset " +
        "environment variable - check NTM_WEBHOOK_SECRET (or whatever you " +
        "named it) is actually reaching this process.",
    );
  }

  const toleranceSeconds = o.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (
    typeof toleranceSeconds !== "number" ||
    !Number.isFinite(toleranceSeconds)
  ) {
    throw new WebhookConfigError(
      `\`toleranceSeconds\` must be a finite number, received ${String(o.toleranceSeconds)}. ` +
        "A NaN tolerance would compare false against every skew and disable " +
        "replay protection without saying so.",
    );
  }
  if (toleranceSeconds < 0) {
    throw new WebhookConfigError(
      `\`toleranceSeconds\` must not be negative, received ${toleranceSeconds}. ` +
        "A negative tolerance rejects every request, including valid ones.",
    );
  }

  const clock = o.now ?? Date.now;
  if (typeof clock !== "function") {
    throw new WebhookConfigError(
      `\`now\` must be a function returning epoch milliseconds, received ${typeof o.now}.`,
    );
  }
  const nowMs = clock();
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new WebhookConfigError(
      `\`now()\` must return a finite epoch-millisecond number, received ${String(nowMs)}.`,
    );
  }

  if (typeof globalThis.crypto?.subtle?.importKey !== "function") {
    throw new WebhookConfigError(
      "WebCrypto (crypto.subtle) is unavailable in this runtime. This module " +
        "uses it deliberately so it runs unchanged on Cloudflare Workers, Deno, " +
        "Bun and Node 20+. On older Node, upgrade - do not shim it with " +
        "node:crypto here.",
    );
  }

  return {
    secret,
    toleranceSeconds,
    nowSeconds: Math.floor(nowMs / 1000),
    body: toBytes(o.rawBody),
  };
}

/**
 * Normalise a raw body to bytes.
 *
 * Takes `unknown` on purpose: the declared type says
 * `Uint8Array | ArrayBuffer | string`, but the failure this guards against -
 * handing the verifier an already-parsed object - comes from JavaScript
 * callers, where the type annotation does not exist.
 *
 * A Node `Buffer` is a `Uint8Array` and lands on the view branch with its byte
 * offset honoured: pooled Buffers share one backing `ArrayBuffer`, so reading
 * `.buffer` without the offset would hash adjacent, unrelated memory.
 */
function toBytes(rawBody: unknown): Bytes {
  if (typeof rawBody === "string") return ENCODER.encode(rawBody);
  if (rawBody instanceof ArrayBuffer) return new Uint8Array(rawBody);
  if (ArrayBuffer.isView(rawBody)) {
    return new Uint8Array(
      rawBody.buffer as ArrayBuffer,
      rawBody.byteOffset,
      rawBody.byteLength,
    );
  }
  throw new WebhookConfigError(
    "`rawBody` must be a Uint8Array, an ArrayBuffer, or a UTF-8 string, " +
      `received ${rawBody === null ? "null" : typeof rawBody}. If you passed an ` +
      "already-parsed body, that cannot be verified: re-serialising JSON can " +
      "change escaping and will break the digest. Capture the raw bytes " +
      "(express.raw({ type: 'application/json' }), await request.arrayBuffer(), " +
      "req.rawBody) and pass those.",
  );
}

/**
 * The whole verification, returning the body bytes on success.
 *
 * Order is fixed: config, then header grammar, then tolerance, then HMAC. The
 * cheap rejections come first, and the HMAC is only computed once we know which
 * `t` to bind into it.
 */
async function verifiedBody(o: VerifyWebhookOptions): Promise<Bytes> {
  const { secret, toleranceSeconds, nowSeconds, body } = resolveOptions(o);

  const header = headerValue(o.signature);
  const { timestamp, digests } = parseSignatureHeader(header);

  if (timestamp === null) {
    throw new WebhookSignatureError(
      `no readable \`t=<unix seconds>\` in the ${SIGNATURE_HEADER} header ` +
        `(got ${excerpt(header)}). Pass the header value verbatim.`,
    );
  }
  if (digests.length === 0) {
    throw new WebhookSignatureError(
      `no \`${SIGNATURE_VERSION}=\` component in the ${SIGNATURE_HEADER} header ` +
        `(got ${excerpt(header)}).`,
    );
  }

  const skew = nowSeconds - timestamp;
  if (Math.abs(skew) > toleranceSeconds) {
    // Say the number. Clock skew is the usual cause and naming the drift saves
    // an hour of staring at an otherwise correct verifier.
    const direction = skew > 0 ? "in the past" : "in the future";
    throw new WebhookSignatureError(
      `timestamp is ${Math.abs(skew)}s ${direction}, outside the ` +
        `${toleranceSeconds}s tolerance (t=${timestamp}, now=${nowSeconds}, ` +
        `skew=${skew > 0 ? "+" : ""}${skew}s). Either this is a replayed or ` +
        "delayed request, or your server's clock has drifted - check NTP " +
        "before raising the tolerance.",
    );
  }

  const expected = await hmacSha256Hex(secret, signedPayload(timestamp, body));

  // Fold every candidate. `|=` rather than `||` and no `break`: the loop runs
  // the same number of iterations whichever candidate matches, and the header
  // may legitimately carry several `v1` values during a secret rotation.
  let matched = 0;
  for (const candidate of digests) {
    matched |= timingSafeEqual(candidate, expected) ? 1 : 0;
  }

  if (matched === 0) {
    throw new WebhookSignatureError(
      `no ${SIGNATURE_VERSION} candidate matched the expected HMAC-SHA256 over ` +
        "`${t}.${rawBody}`. The two usual causes: the body was re-serialised " +
        "before verification (verify the exact bytes you received, not " +
        "JSON.stringify of the parsed object), or the secret belongs to a " +
        "different API key than the one that owns this endpoint.",
    );
  }

  return body;
}

/**
 * Collapse the header parameter to one string.
 *
 * A missing header is a signature failure rather than a config error on
 * purpose: it is a property of the request in front of you, and an unsigned
 * request must be answered 400 exactly like a badly signed one.
 */
function headerValue(signature: VerifyWebhookOptions["signature"]): string {
  if (signature === null || signature === undefined) {
    throw new WebhookSignatureError(
      `no ${SIGNATURE_HEADER} header on the request. Every delivery we make ` +
        "carries one, so an unsigned request did not come from us.",
    );
  }
  const joined = Array.isArray(signature) ? signature.join(",") : signature;
  if (typeof joined !== "string") {
    throw new WebhookSignatureError(
      `${SIGNATURE_HEADER} must be a string or an array of strings, received ${typeof signature}.`,
    );
  }
  if (joined.trim() === "") {
    throw new WebhookSignatureError(
      `the ${SIGNATURE_HEADER} header is present but empty.`,
    );
  }
  return joined;
}

/**
 * Parse `t=..,v1=..,v2=..` into its parts.
 *
 * Byte-for-byte the sender's parser, including its tolerances: split on
 * `,`, split each part at its **first** `=` (a base64-ish value containing `=`
 * therefore survives), trim both sides, and ignore any scheme that is not `t`
 * or `v1`. Tolerating `v2=` is what makes a future digest migration additive
 * instead of a breaking change - the sender can emit both for a deprecation
 * window and old verifiers keep working.
 */
function parseSignatureHeader(header: string): {
  timestamp: number | null;
  digests: string[];
} {
  let timestamp: number | null = null;
  const digests: string[] = [];

  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name === "t") {
      const parsed = Number.parseInt(value, 10);
      timestamp = Number.isFinite(parsed) ? parsed : null;
    } else if (name === SIGNATURE_VERSION) {
      digests.push(value);
    }
  }

  return { timestamp, digests };
}

/**
 * The exact bytes the MAC is taken over: `${t}.` followed by the body, verbatim.
 *
 * Built by concatenation rather than string interpolation so a body that is not
 * valid UTF-8 still hashes to what the sender computed. Never drop the `.`: it
 * binds this timestamp to this body so the two cannot be recombined across
 * requests.
 */
function signedPayload(timestamp: number, body: Bytes): Bytes {
  const prefix = ENCODER.encode(`${timestamp}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

/** Lowercase hex HMAC-SHA256, WebCrypto only. */
async function hmacSha256Hex(secret: string, message: Bytes): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, message);
  return toHex(new Uint8Array(mac));
}

/**
 * Length-independent, value-constant-time compare of two hex strings.
 *
 * Same shape as the sender's constant-time compare: fixed iteration count over
 * the longer input, differences accumulated with `|=`, the length difference
 * folded in, and no early return anywhere. Note it is deliberately
 * case-sensitive - the signer emits lowercase hex and matching its behaviour
 * exactly is the point of this module.
 *
 * JavaScript cannot promise true constant time (the engine is free to optimise
 * either operand), but this removes the part that actually leaks in practice:
 * an early exit whose response time counts correct leading characters.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = ENCODER.encode(a);
  const bb = ENCODER.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte];
  return out;
}

function excerpt(value: string): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > HEADER_EXCERPT_CHARS
    ? `${JSON.stringify(one.slice(0, HEADER_EXCERPT_CHARS))}...`
    : JSON.stringify(one);
}

/* -------------------------------------------------------------------------- */
/* Event parsing - only ever reached on verified bytes                        */
/* -------------------------------------------------------------------------- */

/**
 * Decode and validate an authenticated body.
 *
 * Every failure here is a `WebhookSignatureError`: the bytes were authentic but
 * are not the event we send, which from a handler's point of view is the same
 * decision (400, do not process) and must not be a crash. It is never a
 * `TypeError` from reading `.data.messageId` off `null`.
 *
 * Unknown members are ignored rather than rejected - the payload is
 * additive-only by spec, and an unrecognised `type` is passed through so a
 * second event type can ship without this SDK rejecting it in the field. Switch
 * on `event.type` and reject what you do not recognise, as the spec advises.
 */
function eventFromBytes(body: Bytes): WebhookEvent {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new WebhookSignatureError(
      "the signature verified but the body is not valid UTF-8, so it is not " +
        "the JSON event we send.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new WebhookSignatureError(
      "the signature verified but the body is not valid JSON: " +
        `${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  const event = asRecord(parsed, "the body");
  const data = asRecord(event["data"], "`data`");

  return {
    id: requireString(event["id"], "id"),
    // Cast, not validate: see the note above on forward compatibility.
    type: requireString(event["type"], "type") as WebhookEvent["type"],
    // Epoch SECONDS on the wire, and the same value as `t` in the signature.
    createdAt: new Date(requireFinite(event["createdAt"], "createdAt") * 1000),
    data: {
      messageId: requireString(data["messageId"], "data.messageId"),
      address: requireString(data["address"], "data.address"),
      // Epoch MILLISECONDS on the wire - the one timestamp in the whole API
      // that is not seconds. openapi.yaml calls this out explicitly; do not
      // "fix" it by multiplying.
      receivedAt: new Date(requireFinite(data["receivedAt"], "data.receivedAt")),
    },
  };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebhookSignatureError(
      `the signature verified but ${what} is not a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new WebhookSignatureError(
      "the signature verified but the event is not a valid message.received " +
        `payload: \`${name}\` must be a non-empty string, received ${describe(value)}.`,
    );
  }
  return value;
}

function requireFinite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WebhookSignatureError(
      "the signature verified but the event is not a valid message.received " +
        `payload: \`${name}\` must be a finite number, received ${describe(value)}.`,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return "an empty string";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
