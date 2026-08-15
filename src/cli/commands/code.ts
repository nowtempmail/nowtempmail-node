/**
 * `nowtempmail code <address>` — the hero command.
 *
 * stdout carries the bare code and nothing else. Every status line, every
 * warning and the timeout notice go to stderr, because the documented usage is
 * `CODE=$(nowtempmail code you@example.com)` and a single stray character on
 * stdout breaks it.
 *
 * The mailbox is fetched with one `GET` rather than attached blindly: that turns
 * a typo'd address into "no mailbox …" immediately instead of a 60s wait, and it
 * gives the polling engine the real `createdAt` as its high-water mark, so a code
 * that landed before this process started is still found.
 */

import { flagInteger, flagString, type Flags } from "../args.js";
import { status, writeJson, type CliContext } from "../context.js";
import { EXIT } from "../errors.js";
import { awaitCode, handleWaitFailure } from "./code-wait.js";

export async function codeCommand(
  ctx: CliContext,
  flags: Flags,
  address: string,
): Promise<number> {
  const waitSeconds = flagInteger(flags, "wait") ?? 60;
  const from = flagString(flags, "from");
  const subject = flagString(flags, "subject");

  const mailbox = await ctx.client.mailboxes.get(address);

  const filters = [from ? `from ~ ${from}` : "", subject ? `subject ~ ${subject}` : ""]
    .filter(Boolean)
    .join(" · ");
  status(
    ctx,
    `waiting up to ${waitSeconds}s for a code in ${address}${filters ? ` · ${filters}` : ""}`,
  );

  try {
    const code = await awaitCode(ctx, mailbox, {
      timeoutMs: waitSeconds * 1000,
      ...(from === undefined ? {} : { from }),
      ...(subject === undefined ? {} : { subject }),
    });
    if (ctx.json) writeJson(ctx, { address: mailbox.address, code });
    else ctx.io.out(`${code}\n`);
    return EXIT.OK;
  } catch (err) {
    const handled = handleWaitFailure(ctx, err);
    if (handled !== null) return handled;
    throw err;
  }
}
