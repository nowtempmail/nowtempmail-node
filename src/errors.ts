/**
 * The error hierarchy.
 *
 * Two rules govern this file, both from the rev-2 security review.
 *
 * 1. `instanceof` is not trustworthy here. This package is dual-published
 *    (ESM + CJS), so a consumer can end up with two copies of these classes
 *    loaded at once — an ESM fixture and a CJS app, say. `instanceof` then
 *    silently returns false and an error-handling branch is skipped. Every
 *    class therefore carries a `Symbol.for()` brand, and
 *    `NowTempMailError.is(err)` checks the brand rather than the prototype.
 *    `err.code` is the documented way to branch.
 *
 * 2. Nothing here ever holds the API key. Error messages carry the method, the
 *    path, the problem code and the request id — never a header, never a URL
 *    with credentials in it.
 */

import type {
  PlanId,
  ProblemCode,
  ProblemParameter,
  WireProblem,
} from "./types.js";

/**
 * Cross-realm brand. `Symbol.for` is registry-global, so an ESM copy and a CJS
 * copy of this module agree on it even though their class objects differ.
 */
const BRAND = Symbol.for("nowtempmail.error");

/** Codes this SDK raises that do not come from an HTTP problem document. */
export type LocalErrorCode =
  | "timeout"
  | "connection_error"
  | "browser_use_refused"
  | "mailbox_may_exist"
  | "webhook_signature"
  | "webhook_config"
  | "config_error";

export type AnyErrorCode = ProblemCode | LocalErrorCode;

export interface ErrorContext {
  /** Always present on an error that reached the wire. */
  requestId?: string;
  status?: number;
  method?: string;
  /** Path only — never a full URL, which could carry a query secret. */
  path?: string;
  parameter?: ProblemParameter;
  plan?: PlanId;
  maxTtlSeconds?: number;
  endpointId?: string;
  retryAfter?: number;
  cause?: unknown;
}

/** Base class for everything this package throws. */
export class NowTempMailError extends Error {
  readonly code: AnyErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly parameter?: ProblemParameter;
  readonly plan?: PlanId;
  readonly maxTtlSeconds?: number;
  readonly endpointId?: string;
  /** Seconds. Present on rate_limit_exceeded and quota_exceeded. */
  readonly retryAfter?: number;

  constructor(code: AnyErrorCode, message: string, ctx: ErrorContext = {}) {
    super(message, ctx.cause !== undefined ? { cause: ctx.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.status = ctx.status;
    this.requestId = ctx.requestId;
    this.method = ctx.method;
    this.path = ctx.path;
    this.parameter = ctx.parameter;
    this.plan = ctx.plan;
    this.maxTtlSeconds = ctx.maxTtlSeconds;
    this.endpointId = ctx.endpointId;
    this.retryAfter = ctx.retryAfter;
    Object.defineProperty(this, BRAND, { value: true, enumerable: false });
  }

  /**
   * Brand check that survives the dual-package hazard. Prefer this, or
   * `err.code`, over `instanceof`.
   */
  static is(err: unknown): err is NowTempMailError {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as Record<symbol, unknown>)[BRAND] === true
    );
  }

  /** True when retrying the identical request could plausibly succeed. */
  get retryable(): boolean {
    if (this.code === "rate_limit_exceeded") return true;
    if (this.code === "internal_error") return true;
    if (this.code === "connection_error") return true;
    return false;
  }

  /** Compact one-liner for logs. Contains no credential material. */
  toLogString(): string {
    const bits: string[] = [this.code];
    if (this.status !== undefined) bits.push(`status=${this.status}`);
    if (this.method && this.path) bits.push(`${this.method} ${this.path}`);
    if (this.requestId) bits.push(`requestId=${this.requestId}`);
    if (this.parameter) bits.push(`parameter=${this.parameter}`);
    return bits.join(" ");
  }
}

/* -------------------------------------------------------------------------- */
/* One class per problem code                                                 */
/* -------------------------------------------------------------------------- */

/** 401 — no credential presented, or a malformed Authorization header. */
export class UnauthorizedError extends NowTempMailError {}
/** 401 — the key is not recognised. */
export class InvalidKeyError extends NowTempMailError {}
/** 401 — the key existed and was revoked. Not retryable; rotate it. */
export class KeyRevokedError extends NowTempMailError {}
/** 403 — the whole account is suspended. */
export class AccountSuspendedError extends NowTempMailError {}
/** 403 — authenticated but not permitted. */
export class ForbiddenError extends NowTempMailError {}
/**
 * 403 — the request carried an `Origin` header. /v1 has no CORS by design and
 * rejects these before reading the key. You are calling from a browser.
 */
export class OriginNotAllowedError extends NowTempMailError {}
/**
 * 402 — a paid capability was requested on a plan without it, or a numeric
 * `ttlSeconds` failed validation. `parameter` names the offending field.
 *
 * Note the documented status asymmetry: a `ttlSeconds` that arrives as a JSON
 * number and fails validation is 402 even when merely malformed (`0`, `-1`,
 * `1.5`); only a non-numeric type is 422.
 */
export class PlanUpgradeRequiredError extends NowTempMailError {}
/** 404 — no such resource, or it belongs to another key. Ownership is per-key. */
export class NotFoundError extends NowTempMailError {}
/**
 * 409 — the address is live as a mailbox, or reserved by another account. The
 * API deliberately cannot tell you which; do not speculate in your own message.
 */
export class AddressTakenError extends NowTempMailError {}
/** 409 — the address is reserved. */
export class AddressReservedError extends NowTempMailError {}
/** 422 — malformed request, a reserved local part, or an undecodable cursor. */
export class InvalidRequestError extends NowTempMailError {}
/** 429 — per-minute request ceiling. `retryAfter` is authoritative. */
export class RateLimitExceededError extends NowTempMailError {}
/** 429 — daily mailbox ceiling. Resets 00:00 UTC. */
export class QuotaExceededError extends NowTempMailError {}
/** 500 — server-side fault. Safe to retry idempotent calls. */
export class InternalError extends NowTempMailError {}

/* -------------------------------------------------------------------------- */
/* Local errors — never seen on the wire                                      */
/* -------------------------------------------------------------------------- */

/** A `waitFor*` call gave up. Carries what it did see, which is the useful part. */
export class TimeoutError extends NowTempMailError {
  readonly address: string;
  readonly waitedMs: number;
  readonly messagesSeen: number;

  constructor(opts: {
    address: string;
    waitedMs: number;
    messagesSeen: number;
    what: string;
  }) {
    super(
      "timeout",
      `Timed out after ${Math.round(opts.waitedMs / 1000)}s waiting for ${opts.what} ` +
        `in ${opts.address}. ${opts.messagesSeen} message(s) arrived and none matched.`,
    );
    this.address = opts.address;
    this.waitedMs = opts.waitedMs;
    this.messagesSeen = opts.messagesSeen;
  }
}

/** Transport failed — DNS, TLS, socket, or an aborted request. */
export class ConnectionError extends NowTempMailError {}

/**
 * Thrown at construction in a real browser.
 *
 * /v1 emits no CORS headers and rejects any request carrying an `Origin` header
 * before it reads the key, so a key in browser JavaScript is a published key
 * that also does not work.
 *
 * The check is deliberately narrow: `document` present AND `process.versions.node`
 * absent. A jsdom test environment has both, and must not trip this.
 */
export class BrowserUseRefusedError extends NowTempMailError {
  constructor() {
    super(
      "browser_use_refused",
      "NowTempMail cannot be called from browser JavaScript: /v1 rejects any " +
        "request carrying an Origin header, and an API key shipped to a browser " +
        "is public. Call it from your server. If you are certain this " +
        "environment is not a browser, pass { dangerouslyAllowBrowser: true }.",
    );
  }
}

/**
 * A mailbox creation failed in transport after the request was sent.
 *
 * POST /v1/mailboxes is the only call that consumes daily quota, and the API has
 * no idempotency key, so this SDK will not retry it. The mailbox may well exist
 * server-side, holding an address this process never learned, with quota already
 * spent. That is worth its own error rather than a generic network failure.
 */
export class MailboxMayExistError extends NowTempMailError {
  constructor(cause: unknown) {
    super(
      "mailbox_may_exist",
      "Mailbox creation failed in transport after the request was sent. The " +
        "mailbox may exist and daily quota may already be consumed. This call is " +
        "not retried automatically because it is the only metered endpoint and " +
        "the API has no idempotency key. Check GET /v1/me before retrying.",
      { cause },
    );
  }
}

/** A webhook signature did not verify. Respond 400 and do not process the body. */
export class WebhookSignatureError extends NowTempMailError {
  constructor(reason: string) {
    super("webhook_signature", `Webhook signature verification failed: ${reason}`);
  }
}

/**
 * The verifier was called with unusable configuration — most importantly a
 * missing or blank secret. Refusing here matters: deriving an HMAC key from
 * `undefined` produces a verifier that accepts forgeries, and no test written
 * against a real signature would ever notice.
 */
export class WebhookConfigError extends NowTempMailError {
  constructor(reason: string) {
    super("webhook_config", `Webhook verifier misconfigured: ${reason}`);
  }
}

/** Bad client options — no API key, a non-https baseUrl, and similar. */
export class ConfigError extends NowTempMailError {
  constructor(message: string) {
    super("config_error", message);
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

const BY_CODE: Record<ProblemCode, typeof NowTempMailError> = {
  unauthorized: UnauthorizedError,
  invalid_key: InvalidKeyError,
  key_revoked: KeyRevokedError,
  account_suspended: AccountSuspendedError,
  forbidden: ForbiddenError,
  origin_not_allowed: OriginNotAllowedError,
  plan_upgrade_required: PlanUpgradeRequiredError,
  not_found: NotFoundError,
  address_taken: AddressTakenError,
  address_reserved: AddressReservedError,
  invalid_request: InvalidRequestError,
  rate_limit_exceeded: RateLimitExceededError,
  quota_exceeded: QuotaExceededError,
  internal_error: InternalError,
};

/**
 * Turn a problem+json document into the right class.
 *
 * An unrecognised code is not a crash: it becomes a base NowTempMailError with
 * the code passed through, so a server that grows a fourteenth code does not
 * break older clients.
 */
export function errorFromProblem(
  problem: WireProblem,
  ctx: Omit<ErrorContext, "requestId" | "status"> & { retryAfter?: number } = {},
): NowTempMailError {
  const Cls = BY_CODE[problem.code] ?? NowTempMailError;
  const context: ErrorContext = {
    ...ctx,
    status: problem.status,
    requestId: problem.requestId,
    parameter: problem.parameter,
    plan: problem.plan,
    maxTtlSeconds: problem.maxTtlSeconds,
    endpointId: problem.endpointId,
  };
  return new (Cls as new (
    code: AnyErrorCode,
    message: string,
    ctx?: ErrorContext,
  ) => NowTempMailError)(problem.code, problem.detail || problem.title, context);
}
