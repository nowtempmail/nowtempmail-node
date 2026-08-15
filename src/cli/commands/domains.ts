/**
 * `nowtempmail domains` — what is currently accepting mail.
 *
 * The set rotates as domain health changes, and exactly one entry is the one
 * `new` would pick, so the default is marked rather than left to be inferred from
 * ordering.
 */

import { status, writeJson, type CliContext } from "../context.js";
import { EXIT } from "../errors.js";
import { domainLines } from "../render.js";

export async function domainsCommand(ctx: CliContext): Promise<number> {
  const domains = await ctx.client.domains.list();

  if (ctx.json) {
    writeJson(ctx, { domains: domains.map((d) => ({ domain: d.domain, default: d.default })) });
    return EXIT.OK;
  }

  if (domains.length === 0) {
    status(ctx, "no domains are accepting mail right now");
    return EXIT.OK;
  }

  ctx.io.out(domainLines(domains, ctx.palette));
  return EXIT.OK;
}
