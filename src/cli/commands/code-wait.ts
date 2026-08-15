/**
 * The waiting half of `code` and of `new --wait-code`.
 *
 * Kept in one place because the failure wording is part of the interface: a
 * timeout has to say whether nothing arrived or whether mail arrived carrying no
 * code, and it has to exit 4 either way so a shell script can tell that apart
 * from a revoked key.
 */

import { NowTempMailError } from "../../errors.js";
import type { Mailbox, MessageFilter } from "../../mailbox.js";
import { status, type CliContext } from "../context.js";
import { EXIT, timeoutMessage } from "../errors.js";

export interface CodeWaitOptions {
  timeoutMs: number;
  from?: string;
  subject?: string;
}

/** Build the filter and hand off to the SDK's polling engine. */
export function awaitCode(
  ctx: CliContext,
  mailbox: Mailbox,
  options: CodeWaitOptions,
): Promise<string> {
  const filter: MessageFilter = { timeoutMs: options.timeoutMs };
  if (options.from !== undefined) filter.from = options.from;
  if (options.subject !== undefined) filter.subject = options.subject;
  if (ctx.pollIntervalMs !== undefined) filter.pollIntervalMs = ctx.pollIntervalMs;
  if (ctx.signal !== undefined) filter.signal = ctx.signal;
  return mailbox.waitForCode(filter);
}

/**
 * Turn a failed wait into an exit code, or return `null` to say "not mine" and
 * let the central handler render it.
 *
 * A timeout is not an error in the usual sense — nothing went wrong, the mail
 * did not turn up — so it is amber rather than red, and the line names how many
 * messages were seen.
 */
export function handleWaitFailure(ctx: CliContext, err: unknown): number | null {
  if (ctx.signal?.aborted === true) {
    status(ctx, "stopped");
    return EXIT.INTERRUPTED;
  }
  if (!NowTempMailError.is(err) || err.code !== "timeout") return null;

  const waitedMs = (err as { waitedMs?: number }).waitedMs ?? 0;
  const messagesSeen = (err as { messagesSeen?: number }).messagesSeen ?? 0;
  ctx.io.err(`${ctx.palette.amber(timeoutMessage(waitedMs, messagesSeen, "code"))}\n`);
  return EXIT.TIMEOUT;
}
