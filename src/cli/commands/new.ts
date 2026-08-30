/**
 * `nowtempmail new` — create a mailbox.
 *
 * The address is the whole point of the command, so it goes to stdout on its own
 * line and everything else goes to stderr. `ADDR=$(nowtempmail new)` is the
 * shape this is built for.
 */

import { flagBoolean, flagInteger, flagString, type Flags } from "../args.js";
import { status, warn, writeJson, type CliContext } from "../context.js";
import { EXIT } from "../errors.js";
import { createdStatusLine, mailboxJson } from "../render.js";
import type { CreateMailboxParams } from "../../types.js";
import { awaitCode, handleWaitFailure } from "./code-wait.js";

export async function newCommand(ctx: CliContext, flags: Flags): Promise<number> {
  const params: CreateMailboxParams = {};
  const domain = flagString(flags, "domain");
  if (domain !== undefined) params.domain = domain;
  const ttlSeconds = flagInteger(flags, "ttl");
  if (ttlSeconds !== undefined) params.ttlSeconds = ttlSeconds;
  const address = flagString(flags, "address");
  if (address !== undefined) params.address = address;

  // Never retried by the SDK: it is the only endpoint that spends daily quota.
  const mailbox = await ctx.client.mailboxes.create(params);
  const waitCode = flagBoolean(flags, "wait-code");

  if (!waitCode) {
    if (ctx.json) writeJson(ctx, mailboxJson(mailbox, ctx.client.metering));
    else ctx.io.out(`${mailbox.address}\n`);
    status(ctx, createdStatusLine(mailbox, ctx.client.metering));
    if (!mailbox.confirmed) {
      warn(
        ctx,
        "created, but not readable yet — mail arriving in the next second may be dropped",
      );
    }
    return EXIT.OK;
  }

  // --wait-code: the address first, so a caller sees it even if no code lands.
  if (!ctx.json) ctx.io.out(`${mailbox.address}\n`);
  status(ctx, createdStatusLine(mailbox, ctx.client.metering));

  const waitSeconds = flagInteger(flags, "wait") ?? 60;
  status(ctx, `waiting up to ${waitSeconds}s for a verification code · ⌃C to stop`);
  try {
    const code = await awaitCode(ctx, mailbox, { timeoutMs: waitSeconds * 1000 });
    if (ctx.json) writeJson(ctx, { ...mailboxJson(mailbox, ctx.client.metering), code });
    else ctx.io.out(`${code}\n`);
    return EXIT.OK;
  } catch (err) {
    const handled = handleWaitFailure(ctx, err);
    if (handled !== null) return handled;
    throw err;
  }
}
