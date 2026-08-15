/**
 * What every command is handed.
 *
 * The context exists so command implementations never touch `process`: output
 * goes through {@link Io}, cancellation arrives as an `AbortSignal`, and the
 * client is already built. That is what lets the integration tests call
 * `newCommand(ctx, flags)` against a real mock socket and assert the returned
 * exit code, with no subprocess involved.
 */

import type { NowTempMail } from "../client.js";
import type { Io } from "./io.js";
import type { Palette } from "./style.js";

export interface CliContext {
  io: Io;
  palette: Palette;
  /** `--json` was given. Renderers switch shape; stderr status lines stay. */
  json: boolean;
  client: NowTempMail;
  /** Whatever `--base-url`/`NTM_BASE_URL` resolved to, for error messages. */
  baseUrl?: string;
  /** Aborted on ⌃C. `tail` and the waits honour it. */
  signal?: AbortSignal;
  /**
   * Plan label, once something has called `me()`. Only used to make a
   * rate-limit line read `(30/min on Free)` instead of `(30/min)`.
   */
  planLabel?: string;
  /**
   * Poll interval override in ms, from `NTM_POLL_INTERVAL_MS`. Undocumented in
   * `--help` on purpose: it exists so tests and CI can stop waiting out the 2s
   * rate-limit floor, not as a way to poll the API harder.
   */
  pollIntervalMs?: number;
}

/** A dim status line on stderr. Never data. */
export function status(ctx: CliContext, text: string): void {
  ctx.io.err(`${ctx.palette.dim(text)}\n`);
}

/** An amber warning on stderr. The command carries on. */
export function warn(ctx: CliContext, text: string): void {
  ctx.io.err(`${ctx.palette.amber(text)}\n`);
}

/**
 * A JSON document on stdout. Pretty by default because a human is usually
 * reading it; `compact` is for NDJSON, where one object per line is the point.
 */
export function writeJson(ctx: CliContext, value: unknown, compact = false): void {
  ctx.io.out(`${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
}
