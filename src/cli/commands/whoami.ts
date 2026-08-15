/**
 * `nowtempmail whoami` (alias `me`) — plan, limits and live usage.
 *
 * Prints `keyId`, the short public identifier shown next to a key in the
 * dashboard, and never the secret — including under `--json`. That is not a
 * convention here, it is enforced twice: {@link accountJson} and
 * {@link accountBlock} are given an `Account`, which has no field that could hold
 * a key, and the CLI's writer scrubs the key from every chunk on its way out.
 *
 * `GET /v1/me` runs in peek mode server-side, so polling this does not consume
 * the budget it reports.
 */

import { writeJson, type CliContext } from "../context.js";
import { EXIT } from "../errors.js";
import { accountBlock, accountJson } from "../render.js";

export async function whoamiCommand(ctx: CliContext): Promise<number> {
  const account = await ctx.client.me();
  ctx.planLabel = account.plan.label;

  if (ctx.json) writeJson(ctx, accountJson(account));
  else ctx.io.out(accountBlock(account, ctx.palette));
  return EXIT.OK;
}
