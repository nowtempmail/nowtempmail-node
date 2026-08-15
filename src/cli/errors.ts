/**
 * Exit codes and error rendering.
 *
 * Two rules from the plan are enforced here rather than at each call site:
 *
 * - **Branch on `err.code`, never `instanceof`.** This package is dual-published,
 *   so the CLI bundle and a consumer's copy of the error classes can be two
 *   different objects and `instanceof` then quietly returns false.
 * - **Always surface the requestId.** It is the only thing support can act on,
 *   and it is free to print.
 *
 * The messages are written for somebody who is mid-task in a terminal: what
 * happened, and what to do about it, in one line.
 */

import { NowTempMailError } from "../errors.js";
import type { MeteringSnapshot } from "../types.js";
import { formatDuration, plural, type Palette } from "./style.js";

/**
 * The documented exit codes. A shell script branches on these, so they are as
 * much a part of the interface as the output is.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** An API or runtime failure, including a quota that is spent. */
  FAIL: 1,
  /** Bad usage, or a missing/rejected API key. */
  USAGE: 2,
  /**
   * A `--wait` window elapsed with no match — `code`, or `new --wait-code`.
   *
   * Not `tail`, despite what an earlier version of this comment said: `tail`
   * polls without a deadline and exits 0 when interrupted.
   */
  TIMEOUT: 4,
  /** Interrupted with ⌃C while waiting for something specific. */
  INTERRUPTED: 130,
} as const;

export const KEYS_URL = "https://nowtempmail.com/developers/keys";
export const PRICING_URL = "https://nowtempmail.com/developers/pricing";

export const NO_API_KEY_MESSAGE = `no API key. Set NTM_API_KEY — get one at ${KEYS_URL}`;

export interface DescribeContext {
  /** Latest metering, used to make quota and rate-limit messages concrete. */
  metering?: MeteringSnapshot | null;
  /** The address the failing command was operating on, when there was one. */
  address?: string;
  /** The host we were talking to, for connection failures. */
  baseUrl?: string;
  /** Plan label, when a `me()` call has already told us. */
  planLabel?: string;
}

export interface DescribedError {
  message: string;
  exit: number;
  requestId?: string;
}

function codeOf(err: unknown): string | undefined {
  if (NowTempMailError.is(err)) return err.code;
  return undefined;
}

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "the API";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** `(50/50)` plus a reset, from whatever metering we last saw. */
function quotaDetail(metering: MeteringSnapshot | null | undefined): string {
  const quota = metering?.quota;
  if (!quota) return "daily mailbox quota reached. It resets at 00:00 UTC.";
  const used = Math.max(0, quota.limit - quota.remaining);
  const resetIn = quota.reset.getTime() - Date.now();
  return (
    `daily mailbox quota reached (${used}/${quota.limit}). ` +
    `Resets 00:00 UTC in ${formatDuration(resetIn)}.`
  );
}

/**
 * The amber line a long-running command prints when the per-minute window is
 * exhausted. It is a status update, not a failure: the SDK is already waiting
 * and will carry on.
 */
export function rateLimitNotice(opts: {
  retryAfterSeconds?: number;
  limit?: number;
  planLabel?: string;
}): string {
  const seconds = Math.max(1, Math.round(opts.retryAfterSeconds ?? 1));
  const budget = opts.limit === undefined ? "" : `${opts.limit}/min`;
  const plan = opts.planLabel === undefined ? "" : `on ${opts.planLabel}`;
  const parenthetical = [budget, plan].filter(Boolean).join(" ");
  const suffix = parenthetical ? ` (${parenthetical})` : "";
  return `rate limited — resuming in ${seconds}s${suffix}`;
}

/**
 * Map any thrown value onto a one-line message and an exit code.
 *
 * Unknown codes are not a crash: a server that grows a fifteenth problem code
 * still produces a usable line, because `detail` is prose written for exactly
 * this purpose.
 */
export function describeError(err: unknown, ctx: DescribeContext = {}): DescribedError {
  const code = codeOf(err);
  const requestId = NowTempMailError.is(err) ? err.requestId : undefined;
  const detail = err instanceof Error ? err.message : String(err);
  const address = ctx.address;

  const described = (message: string, exit: number): DescribedError => ({
    message,
    exit,
    requestId,
  });

  switch (code) {
    case undefined:
      // Not one of ours: a bug in this CLI, or a runtime fault.
      return described(detail, EXIT.FAIL);

    case "unauthorized":
    case "invalid_key":
      return described(
        `the API key was rejected. Check NTM_API_KEY — manage keys at ${KEYS_URL}`,
        EXIT.USAGE,
      );

    case "key_revoked":
      return described(`that key was revoked. Create a new one at ${KEYS_URL}`, EXIT.USAGE);

    case "config_error":
      return described(detail, EXIT.USAGE);

    case "account_suspended":
      return described(
        "this account is suspended, so every request will fail. Contact support with the request id.",
        EXIT.FAIL,
      );

    case "forbidden":
      return described(detail, EXIT.FAIL);

    case "origin_not_allowed":
      // Only reachable if something injected an Origin header. Worth saying why.
      return described(
        "the API refused the request because it carried an Origin header. /v1 has no CORS by design.",
        EXIT.FAIL,
      );

    case "plan_upgrade_required": {
      const parameter = NowTempMailError.is(err) ? err.parameter : undefined;
      const max = NowTempMailError.is(err) ? err.maxTtlSeconds : undefined;
      const which = parameter ? `\`--${parameter === "ttlSeconds" ? "ttl" : parameter}\`` : "that";
      const ceiling =
        parameter === "ttlSeconds" && max !== undefined
          ? ` This plan allows up to ${formatDuration(max * 1000)}.`
          : "";
      return described(
        `${which} needs a paid plan.${ceiling} See ${PRICING_URL}`,
        EXIT.FAIL,
      );
    }

    case "not_found":
      return described(
        address
          ? `no mailbox ${address} — it may have expired, or it belongs to another key`
          : detail,
        EXIT.FAIL,
      );

    case "address_taken":
      return described(
        "that address is not available. Pick another local part, or omit --address.",
        EXIT.FAIL,
      );

    case "address_reserved":
      return described("that address is reserved. Pick another local part.", EXIT.FAIL);

    case "invalid_request": {
      const parameter = NowTempMailError.is(err) ? err.parameter : undefined;
      const prefix = parameter ? `\`--${parameter === "ttlSeconds" ? "ttl" : parameter}\`: ` : "";
      // The API is complaining about an argument, which makes it usage.
      return described(`${prefix}${detail}`, EXIT.USAGE);
    }

    case "rate_limit_exceeded": {
      const limit = ctx.metering?.rateLimit?.limit;
      const retryAfter = NowTempMailError.is(err) ? err.retryAfter : undefined;
      const budget = limit === undefined ? "" : ` (${limit}/min${ctx.planLabel ? ` on ${ctx.planLabel}` : ""})`;
      const when = retryAfter === undefined ? "" : ` Try again in ${Math.max(1, Math.round(retryAfter))}s.`;
      return described(`rate limited${budget}.${when}`.trimEnd(), EXIT.FAIL);
    }

    case "quota_exceeded":
      return described(quotaDetail(ctx.metering), EXIT.FAIL);

    case "internal_error":
      return described(
        `the API failed on its side and the retries did not help. Quote the request id to support.`,
        EXIT.FAIL,
      );

    case "timeout": {
      const seen = (err as { messagesSeen?: number }).messagesSeen ?? 0;
      const waited = (err as { waitedMs?: number }).waitedMs ?? 0;
      return described(timeoutMessage(waited, seen, "code"), EXIT.TIMEOUT);
    }

    case "connection_error":
      return described(
        `could not reach ${hostOf(ctx.baseUrl)}: ${detail}`,
        EXIT.FAIL,
      );

    case "mailbox_may_exist":
      return described(
        "the mailbox may have been created even though the connection failed, and " +
          "daily quota may already be spent. Run `nowtempmail whoami` before retrying.",
        EXIT.FAIL,
      );

    default:
      return described(detail, EXIT.FAIL);
  }
}

/**
 * The wording a timed-out wait gets. `messagesSeen` is the difference between
 * "nothing arrived" and "mail arrived but carried no code", which is the first
 * thing anybody debugging a flaky signup wants to know.
 */
export function timeoutMessage(waitedMs: number, messagesSeen: number, what = "code"): string {
  const window = formatDuration(waitedMs);
  if (messagesSeen === 0) return `no ${what} in ${window} — no messages arrived`;
  return (
    `no ${what} in ${window} — ${messagesSeen} ${plural(messagesSeen, "message")} arrived, ` +
    `none carried a ${what}`
  );
}

/** `error: …` on one line, with the request id appended when we have one. */
export function formatErrorLine(described: DescribedError, palette: Palette): string {
  const tail = described.requestId ? palette.dim(` · request ${described.requestId}`) : "";
  return `${palette.red("error:")} ${described.message}${tail}\n`;
}

/** True when this error is an abort caused by the user's ⌃C. */
export function isInterrupted(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted !== true) return false;
  return codeOf(err) === "connection_error" || codeOf(err) === "timeout";
}
