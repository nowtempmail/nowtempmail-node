/**
 * `nowtempmail ls <address>` — one page of recent messages.
 *
 * Deliberately one request: `attach()` builds the handle with no round trip, and
 * a mailbox that does not exist is a 404 from the messages endpoint anyway, so
 * verifying it first would only double the traffic.
 *
 * Only the table goes to stdout. "no messages yet" is a human observation, not
 * data, so it goes to stderr and leaves stdout empty — which is what `wc -l` and
 * `test -s` expect.
 */

import { flagInteger, type Flags } from "../args.js";
import { status, writeJson, type CliContext } from "../context.js";
import { EXIT } from "../errors.js";
import { messageJson, messagesTable } from "../render.js";

export async function lsCommand(
  ctx: CliContext,
  flags: Flags,
  address: string,
): Promise<number> {
  const limit = flagInteger(flags, "limit") ?? 25;
  const mailbox = ctx.client.mailboxes.attach(address);
  const page = await mailbox.messages.page({ limit });

  if (ctx.json) {
    writeJson(ctx, {
      address: mailbox.address,
      messages: page.messages.map(messageJson),
      hasMore: page.hasMore,
    });
    return EXIT.OK;
  }

  if (page.messages.length === 0) {
    status(ctx, `no messages in ${mailbox.address} yet`);
    return EXIT.OK;
  }

  ctx.io.out(messagesTable(page.messages, ctx.palette));
  if (page.hasMore) status(ctx, `more messages beyond --limit ${limit}`);
  return EXIT.OK;
}
