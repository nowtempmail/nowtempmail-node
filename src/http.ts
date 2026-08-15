/**
 * The transport. Everything that touches the network goes through `Http.request`.
 *
 * Five properties of this file are load-bearing and were fixed by the rev-2
 * security review. None of them are style preferences:
 *
 * 1. `redirect: "error"` on every request. `fetch` would otherwise replay the
 *    `Authorization` header to whatever host a `Location` names, and a bearer
 *    token that follows a redirect it did not choose is a leaked token.
 * 2. `POST` is never retried by default. `POST /v1/mailboxes` is the only
 *    endpoint that consumes daily quota and the API has no idempotency key, so
 *    a blind retry can silently spend a second mailbox. `GET`/`DELETE` retry.
 * 3. The `Authorization` header is assembled at the last possible moment and is
 *    never put in the object handed to `onRequest`. Hooks get a redacted copy.
 * 4. A generated `X-Request-Id` always matches `^req_[A-Za-z0-9_-]{16,32}$`, and
 *    a caller-supplied one is validated against the same pattern rather than
 *    forwarded verbatim — this value is echoed into server logs.
 * 5. Errors never carry a URL. Method and path only, plus the request id, which
 *    is what support asks for.
 */

import {
  ConfigError,
  ConnectionError,
  InternalError,
  NowTempMailError,
  errorFromProblem,
} from "./errors.js";
import { PROBLEM_CODES } from "./types.js";
import type { MeteringSnapshot, ProblemCode, WireProblem } from "./types.js";

/**
 * The published version, duplicated here so the User-Agent can carry it without
 * importing `package.json` (which would need `resolveJsonModule` and would put a
 * copy of the manifest in every bundle).
 *
 * It is therefore hand-maintained, and a hand-maintained duplicate drifts. Bump
 * it in the same commit as `package.json`; `test/core/http.test.ts` fails if the
 * two disagree, which is the only thing keeping them honest. npm versions are
 * immutable, so a wrong value here is wrong forever on that release.
 */
export const VERSION = "0.1.0";

/**
 * The shape `X-Request-Id` must have. Deliberately narrow: the value is echoed
 * back by the API and written to its logs, so an arbitrary caller-supplied
 * string is a log-injection vector we decline to forward.
 */
export const REQUEST_ID_PATTERN = /^req_[A-Za-z0-9_-]{16,32}$/;

/** The floor on a derived poll interval, in ms. See `pollIntervalMs`. */
export const MIN_POLL_INTERVAL_MS = 2_000;

const RID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/* -------------------------------------------------------------------------- */
/* Public option and hook shapes                                              */
/* -------------------------------------------------------------------------- */

export interface RequestHookEvent {
  method: string;
  path: string;
  requestId: string;
  /** 1 for the first try. */
  attempt: number;
  /**
   * The outbound headers **with `Authorization` removed**. The API key is never
   * present in this object, or anywhere reachable from it.
   */
  headers: Readonly<Record<string, string>>;
}

export interface ResponseHookEvent {
  method: string;
  path: string;
  requestId: string;
  status: number;
  durationMs: number;
  metering: MeteringSnapshot;
}

export interface LowQuotaEvent {
  remaining: number;
  limit: number;
  reset: Date;
}

/**
 * `ClientOptions` after defaults, validation and env lookup. This is what the
 * transport actually runs on; `NowTempMail` produces it.
 */
export interface ResolvedClientOptions {
  apiKey: string;
  /** Absolute, https (or http on an explicit localhost), no trailing slash. */
  baseUrl: string;
  timeoutMs: number;
  /** GET/DELETE only. POST is never retried. */
  maxRetries: number;
  fetch: typeof globalThis.fetch;
  userAgent: string;
  lowQuotaThreshold: number;
  onRequest?: (e: RequestHookEvent) => void;
  onResponse?: (e: ResponseHookEvent) => void;
  onLowQuota?: (e: LowQuotaEvent) => void;
}

export interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  /** Already prefixed: `"/v1/mailboxes"`. */
  path: string;
  query?: Record<string, string | number | undefined>;
  /** `JSON.stringify`'d when present. */
  body?: unknown;
  signal?: AbortSignal;
  /** Opt out of retries (mailbox creation). Default: GET/DELETE retry, POST does not. */
  retry?: boolean;
  /** Expect bytes rather than JSON (attachment download). */
  raw?: boolean;
  /**
   * Your own correlation id. Must match {@link REQUEST_ID_PATTERN} or this
   * throws `ConfigError` — arbitrary strings are not forwarded to the API's logs.
   * Omit and one is generated.
   */
  requestId?: string;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  requestId: string;
  metering: MeteringSnapshot;
  headers: Headers;
}

/* -------------------------------------------------------------------------- */
/* Small helpers, exported because the CLI and tests want them too            */
/* -------------------------------------------------------------------------- */

/** A fresh `req_…` id: 21 URL-safe characters, so 126 bits of entropy. */
export function generateRequestId(): string {
  const bytes = new Uint8Array(21);
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(bytes);
  } else {
    // Only reachable on a runtime with no WebCrypto. A request id is a
    // correlation token, not a secret, so Math.random is an acceptable floor.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "req_";
  for (const b of bytes) out += RID_ALPHABET.charAt(b & 63);
  return out;
}

/** Validate a caller-supplied request id, or throw `ConfigError`. */
export function assertValidRequestId(id: string): string {
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new ConfigError(
      `requestId must match ${String(REQUEST_ID_PATTERN)}. Received a value of ` +
        `length ${id.length}. Request ids are echoed into server logs, so this ` +
        `SDK will not forward an arbitrary string.`,
    );
  }
  return id;
}

/** `setTimeout` as a promise, rejecting with `ConnectionError` if aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortError(signal?: AbortSignal): NowTempMailError {
  const reason = signal?.reason;
  const detail = reason instanceof Error ? `: ${reason.message}` : "";
  return new ConnectionError("connection_error", `The request was aborted${detail}.`, {
    cause: reason,
  });
}

const PROBLEM_CODE_SET: ReadonlySet<string> = new Set<string>(PROBLEM_CODES);
/** What a machine-readable code is allowed to look like. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === "string" && PROBLEM_CODE_SET.has(value);
}

/**
 * Accept a code we have never heard of, as long as it is shaped like one.
 *
 * `errorFromProblem` deliberately passes an unrecognised code through on the
 * base class so that a server growing a fifteenth code does not break older
 * clients. Rewriting it to something from the status table here would undo that.
 * The shape check is only to keep a garbled body from putting arbitrary text on
 * `err.code`, which callers branch on.
 */
function isForwardCompatibleCode(value: unknown): value is ProblemCode {
  return typeof value === "string" && CODE_SHAPE.test(value);
}

/**
 * A code for a response whose body was not a usable problem document. The API
 * always sends one; a proxy, a WAF or a 502 page in front of it may not.
 */
function codeForStatus(status: number): ProblemCode {
  switch (status) {
    case 401:
      return "unauthorized";
    case 402:
      return "plan_upgrade_required";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "address_taken";
    case 400:
    case 422:
      return "invalid_request";
    case 429:
      return "rate_limit_exceeded";
    default:
      return status >= 500 ? "internal_error" : "invalid_request";
  }
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Read `X-RateLimit-*` / `X-Quota-*` off a response. */
export function readMetering(headers: Headers): MeteringSnapshot {
  const rl = headerNumber(headers, "X-RateLimit-Limit");
  const rr = headerNumber(headers, "X-RateLimit-Remaining");
  const rs = headerNumber(headers, "X-RateLimit-Reset");
  const ql = headerNumber(headers, "X-Quota-Limit");
  const qr = headerNumber(headers, "X-Quota-Remaining");
  const qs = headerNumber(headers, "X-Quota-Reset");
  return {
    rateLimit:
      rl !== null && rr !== null && rs !== null
        ? { limit: rl, remaining: rr, reset: new Date(rs * 1000) }
        : null,
    quota:
      ql !== null && qr !== null && qs !== null
        ? { limit: ql, remaining: qr, reset: new Date(qs * 1000) }
        : null,
  };
}

/** `Retry-After` in seconds. Both the delta-seconds and HTTP-date forms. */
export function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  return undefined;
}

/**
 * One `AbortSignal` that fires when the caller's does, or when `timeoutMs`
 * elapses. Hand-rolled rather than `AbortSignal.any`, which is newer than the
 * Node 20 floor this package supports.
 */
function linkSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Http                                                                       */
/* -------------------------------------------------------------------------- */

export class Http {
  readonly #options: ResolvedClientOptions;
  #metering: MeteringSnapshot = { rateLimit: null, quota: null };
  #watchers = 0;
  #lastLowQuotaNotified: number | null = null;

  constructor(options: ResolvedClientOptions) {
    this.#options = options;
  }

  get baseUrl(): string {
    return this.#options.baseUrl;
  }

  /**
   * The most recent metering snapshot. Before the first request both members
   * are `null`; a response that omits a header set (attachment downloads carry
   * no rate-limit headers) leaves the previous value in place rather than
   * clearing it.
   */
  get metering(): MeteringSnapshot {
    return this.#metering;
  }

  /** How many `waitFor*` loops are currently sharing the rate limit. */
  get watchers(): number {
    return this.#watchers;
  }

  /**
   * A poll interval that keeps `watchers` concurrent watchers inside the
   * key's per-minute request budget, floored at {@link MIN_POLL_INTERVAL_MS}.
   *
   * A Free key gets 30 requests a minute, so one watcher lands exactly on the
   * 2s floor and two watchers get 4s. Without the division, N watchers on one
   * key would rate-limit each other and every one of them would slow down.
   */
  pollIntervalMs(watchers = 1): number {
    const limit = this.#metering.rateLimit?.limit ?? 30;
    const n = Math.max(1, Math.floor(watchers) || 1);
    const ideal = limit > 0 ? (60_000 * n) / limit : MIN_POLL_INTERVAL_MS;
    return Math.max(MIN_POLL_INTERVAL_MS, Math.ceil(ideal));
  }

  /** Count a watcher in. The returned function deregisters it, once. */
  registerWatcher(): () => void {
    this.#watchers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#watchers = Math.max(0, this.#watchers - 1);
    };
  }

  async request<T>(opts: RequestOptions): Promise<HttpResult<T>> {
    const { method, path } = opts;
    const requestId =
      opts.requestId === undefined
        ? generateRequestId()
        : assertValidRequestId(opts.requestId);
    const url = this.#url(path, opts.query);

    // POST is opt-in for retries, never opt-out-by-accident: see rule 2 above.
    const retryEnabled = opts.retry ?? method !== "POST";
    const maxAttempts = retryEnabled ? Math.max(0, this.#options.maxRetries) + 1 : 1;

    const safeHeaders: Record<string, string> = {
      Accept: opts.raw
        ? "application/octet-stream, application/problem+json"
        : "application/json, application/problem+json",
      "User-Agent": this.#options.userAgent,
      "X-Request-Id": requestId,
    };
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      bodyText = JSON.stringify(opts.body);
      safeHeaders["Content-Type"] = "application/json";
    }
    // Frozen so a hook cannot mutate what the next attempt sends, and built
    // *before* Authorization exists so there is no chance of leaking it.
    const hookHeaders = Object.freeze({ ...safeHeaders });
    const wireHeaders: Record<string, string> = {
      ...safeHeaders,
      Authorization: `Bearer ${this.#options.apiKey}`,
    };

    const doFetch = this.#options.fetch;

    for (let attempt = 1; ; attempt++) {
      this.#fire(this.#options.onRequest, {
        method,
        path,
        requestId,
        attempt,
        headers: hookHeaders,
      });

      const started = Date.now();
      const link = linkSignals(opts.signal, this.#options.timeoutMs);
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: wireHeaders,
          body: bodyText,
          signal: link.signal,
          // Never follow a Location we did not choose: that replays the bearer
          // token to an arbitrary host.
          redirect: "error",
        });
      } catch (cause) {
        link.cleanup();
        const error = this.#transportError(cause, { method, path, requestId });
        const userAborted = opts.signal?.aborted === true;
        if (retryEnabled && attempt < maxAttempts && !userAborted) {
          await sleep(this.#backoff(attempt), opts.signal);
          continue;
        }
        throw error;
      }

      try {
        const metering = this.#absorbMetering(response.headers);
        const status = response.status;
        const echoed = response.headers.get("X-Request-Id") ?? requestId;

        this.#fire(this.#options.onResponse, {
          method,
          path,
          requestId,
          status,
          durationMs: Date.now() - started,
          metering,
        });

        if (!response.ok) {
          const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
          const problem = await readProblem(response, echoed);
          const error = errorFromProblem(problem, { method, path, retryAfter });
          const worthRetrying = status === 429 || status >= 500;
          if (retryEnabled && attempt < maxAttempts && worthRetrying) {
            // On 429 the server told us exactly how long to wait. Honour it
            // rather than guessing with a backoff curve.
            const wait =
              status === 429 && retryAfter !== undefined
                ? retryAfter * 1000
                : this.#backoff(attempt);
            await sleep(wait, opts.signal);
            continue;
          }
          throw error;
        }

        const data = await readSuccess<T>(response, opts.raw === true, {
          method,
          path,
          requestId: echoed,
        });
        return { data, status, requestId: echoed, metering, headers: response.headers };
      } finally {
        link.cleanup();
      }
    }
  }

  /* ---------------------------------------------------------------------- */

  #url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.#options.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  #backoff(attempt: number): number {
    const base = Math.min(8_000, 250 * 2 ** (attempt - 1));
    // Full-ish jitter, so N clients that failed together do not retry together.
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  #transportError(
    cause: unknown,
    ctx: { method: string; path: string; requestId: string },
  ): NowTempMailError {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const redirected = /redirect/i.test(reason);
    const message = redirected
      ? `${ctx.method} ${ctx.path} responded with a redirect. This SDK refuses ` +
        `to follow one, because doing so would replay your API key to a host ` +
        `the API chose rather than one you configured.`
      : `${ctx.method} ${ctx.path} failed before a response was received: ${reason}`;
    return new ConnectionError("connection_error", message, {
      method: ctx.method,
      path: ctx.path,
      requestId: ctx.requestId,
      cause,
    });
  }

  #absorbMetering(headers: Headers): MeteringSnapshot {
    const seen = readMetering(headers);
    const merged: MeteringSnapshot = {
      rateLimit: seen.rateLimit ?? this.#metering.rateLimit,
      quota: seen.quota ?? this.#metering.quota,
    };
    this.#metering = merged;

    const quota = seen.quota;
    if (
      quota &&
      this.#options.onLowQuota &&
      quota.remaining < this.#options.lowQuotaThreshold &&
      quota.remaining !== this.#lastLowQuotaNotified
    ) {
      this.#lastLowQuotaNotified = quota.remaining;
      this.#fire(this.#options.onLowQuota, {
        remaining: quota.remaining,
        limit: quota.limit,
        reset: quota.reset,
      });
    }
    return merged;
  }

  /** A throwing hook is the caller's bug, not a failed request. */
  #fire<E>(hook: ((e: E) => void) | undefined, event: E): void {
    if (!hook) return;
    try {
      hook(event);
    } catch {
      /* ignored on purpose */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Body readers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Coerce any error response into a `WireProblem`.
 *
 * The API always sends RFC 9457. Intermediaries do not: a 502 from a proxy is
 * an HTML page, and a truncated response is nothing at all. Either way this
 * must produce a usable error carrying a request id, never a parse crash.
 */
async function readProblem(response: Response, fallbackRequestId: string): Promise<WireProblem> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    /* body already consumed or the stream died — treat as empty */
  }

  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
  }
  const raw: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  const code = isProblemCode(raw.code)
    ? raw.code
    : isForwardCompatibleCode(raw.code)
      ? raw.code
      : codeForStatus(response.status);
  const detail =
    typeof raw.detail === "string" && raw.detail
      ? raw.detail
      : typeof raw.title === "string" && raw.title
        ? raw.title
        : `The API returned HTTP ${response.status} with ` +
          (text ? "a body that is not a problem document." : "an empty body.");

  const problem: WireProblem = {
    type:
      typeof raw.type === "string"
        ? raw.type
        : `https://nowtempmail.com/developers/errors#${code}`,
    code,
    title: typeof raw.title === "string" && raw.title ? raw.title : `HTTP ${response.status}`,
    status: typeof raw.status === "number" ? raw.status : response.status,
    detail,
    // Never absent. Support asks for this value, and an error without one is
    // an error nobody can chase.
    requestId:
      typeof raw.requestId === "string" && raw.requestId ? raw.requestId : fallbackRequestId,
  };
  if (typeof raw.parameter === "string") {
    problem.parameter = raw.parameter as WireProblem["parameter"];
  }
  if (typeof raw.plan === "string") problem.plan = raw.plan as WireProblem["plan"];
  if (typeof raw.maxTtlSeconds === "number") problem.maxTtlSeconds = raw.maxTtlSeconds;
  if (typeof raw.endpointId === "string") problem.endpointId = raw.endpointId;
  return problem;
}

async function readSuccess<T>(
  response: Response,
  raw: boolean,
  ctx: { method: string; path: string; requestId: string },
): Promise<T> {
  if (raw) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer) as unknown as T;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new InternalError(
      "internal_error",
      `${ctx.method} ${ctx.path} returned HTTP ${response.status} with a body that is not JSON.`,
      { status: response.status, requestId: ctx.requestId, method: ctx.method, path: ctx.path, cause },
    );
  }
}
