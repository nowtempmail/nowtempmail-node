/**
 * `nowtempmail rm <address>` — delete a mailbox and its mail.
 *
 * Reports what went with it, because "deleted" alone hides the case where you
 * removed an inbox that still had unread mail in it. Daily quota is not refunded,
 * which is why this command does not offer a `--force`-style shortcut for
 * deleting several: there is no upside.
 */

import { status, writeJson, type CliContext } from "../context.js";
import { EXIT } from "../errors.js";
import { plural } from "../style.js";

export async function rmCommand(
  ctx: CliContext,
  _flags: unknown,
  address: string,
): Promise<number> {
  const result = await ctx.client.mailboxes.delete(address);

  if (ctx.json) {
    writeJson(ctx, { address: result.address, deletedMessages: result.deletedMessages });
    return EXIT.OK;
  }

  ctx.io.out(`${result.address}\n`);
  status(
    ctx,
    `deleted · ${result.deletedMessages} ${plural(result.deletedMessages, "message")} went with it · quota is not refunded`,
  );
  return EXIT.OK;
}
