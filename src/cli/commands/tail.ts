/**
 * `nowtempmail tail <address>` — follow an inbox.
 *
 * Three decisions worth knowing:
 *
 * - **The poll interval is derived, not guessed.** One `me()` call (which runs in
 *   peek mode server-side and does not spend the budget it reports) gives the
 *   key's per-minute limit, and `Http.pollIntervalMs` turns that into an interval
 *   with a 2s floor. It is printed to stderr before anything else so nobody has
 *   to wonder why output arrives every two seconds.
 * - **Mail already in the mailbox is not reprinted.** The first page seeds the
 *   dedupe set silently; `ls` is the command for history. A `tail` that dumps a
 *   backlog into a CI log is noise.
 * - **A rate limit is a status line, not a failure.** The window is waited out
 *   and polling resumes. Only a real error ends the command.
 *
 * ⌃C stops polling, writes nothing further to stdout, and exits 0.
 */

import { NowTempMailError } from "../../errors.js";
import type { MessagePage } from "../../types.js";
import { status, warn, writeJson, type CliContext } from "../context.js";
import { EXIT, rateLimitNotice } from "../errors.js";
import { messageJson, messageLine } from "../render.js";
import { sleepOrAbort } from "../wait.js";

const PAGE_SIZE = 25;

export async function tailCommand(
  ctx: CliContext,
  _flags: unknown,
  address: string,
): Promise<number> {
  // Peek mode: this call reports the budget without consuming it, and it is what
  // makes both the interval and the `(30/min on Free)` suffix real numbers.
  const account = await ctx.client.me();
  ctx.planLabel = account.plan.label;

  const mailbox = await ctx.client.mailboxes.get(address);
  const intervalMs = ctx.pollIntervalMs ?? ctx.client.http.pollIntervalMs(1);

  // Establish the baseline BEFORE announcing that we are watching.
  //
  // This snapshot is what decides which messages count as backlog, and mail that
  // lands between the announcement and the snapshot would be absorbed into it —
  // silently never printed, despite arriving after we said we were watching.
  // Announcing afterwards makes the line true when it is said: everything that
  // arrives from that point on gets printed.
  const seen = new Set<string>();
  const first = await mailbox.messages.page({ limit: PAGE_SIZE });
  for (const message of first.messages) seen.add(message.id);
  if (first.messages.length > 0) {
    status(
      ctx,
      `${first.messages.length} message(s) already here — not replayed, run \`nowtempmail ls ${address}\` for those`,
    );
  }
  status(ctx, `watching · polling every ${(intervalMs / 1000).toFixed(1)}s · ⌃C to stop`);

  let printed = 0;
  for (;;) {
    if ((await sleepOrAbort(intervalMs, ctx.signal)) === "aborted") break;

    let page: MessagePage;
    try {
      page = await mailbox.messages.page({ limit: PAGE_SIZE });
    } catch (err) {
      if (NowTempMailError.is(err) && err.code === "rate_limit_exceeded") {
        const retryAfterSeconds = err.retryAfter ?? 2;
        warn(
          ctx,
          rateLimitNotice({
            retryAfterSeconds,
            limit: ctx.client.metering.rateLimit?.limit,
            ...(ctx.planLabel === undefined ? {} : { planLabel: ctx.planLabel }),
          }),
        );
        if ((await sleepOrAbort(retryAfterSeconds * 1000, ctx.signal)) === "aborted") break;
        continue;
      }
      throw err;
    }

    // The API returns newest first; print in arrival order so a log reads down.
    const fresh = page.messages.filter((m) => !seen.has(m.id)).reverse();
    for (const message of fresh) {
      seen.add(message.id);
      printed++;
      if (ctx.json) writeJson(ctx, { address: mailbox.address, ...messageJson(message) }, true);
      else ctx.io.out(messageLine(message, ctx.palette));
    }
  }

  status(ctx, `stopped · ${printed} message(s) printed`);
  return EXIT.OK;
}
