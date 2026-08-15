/**
 * Polling with a custom filter, and reading history properly.
 *
 *   export NTM_API_KEY="ntm_test_..."
 *   npx tsx examples/custom-filter.ts
 *
 * `verificationCodes` is a heuristic, not an oracle: 4-8 digit numeric codes and
 * 6-10 character uppercase alphanumeric codes with at least one digit, found
 * within 200 characters of a word like "code", "otp", "verify" or "passcode". A
 * marketing footer saying "use code SAVE20 at checkout" matches that as happily
 * as your OTP does, and one message can yield several candidates in no
 * meaningful order.
 *
 * So when it matters, filter first. `match` is the escape hatch: an arbitrary
 * predicate over the message summary, evaluated after from/subject/after and
 * before the code is handed back.
 */

import { NowTempMail, NowTempMailError, type MessageSummary } from "nowtempmail";

const ntm = new NowTempMail();

async function main(): Promise<void> {
  const inbox = await ntm.mailboxes.create();
  console.log(`mailbox: ${inbox.address}`);

  /* ---------------------------------------------------------------- *
   * 1. A predicate that only accepts an unambiguous six-digit code.
   * ---------------------------------------------------------------- */

  const isSixDigits = (code: string): boolean => /^\d{6}$/.test(code);

  try {
    const code = await inbox.waitForCode({
      from: /@myapp\.example>?$/, // tested against the raw From header
      subject: /verification|verify/i,
      ignoreExisting: true,
      match: (m: MessageSummary) => m.verificationCodes.filter(isSixDigits).length === 1,
      timeoutMs: 120_000,
      // Leave pollIntervalMs unset. The default is derived from the live
      // X-RateLimit-Limit header divided by the number of concurrent watchers,
      // floor 2000ms, which is what keeps parallel waiters off a shared 429.
    });
    console.log(`unambiguous code: ${code}`);
  } catch (err) {
    if (!NowTempMailError.is(err) || err.code !== "timeout") throw err;
    console.warn(`nothing matched: ${err.message}`);
  }

  /* ---------------------------------------------------------------- *
   * 2. waitForMessage when you need the body, not just the code.
   * ---------------------------------------------------------------- */

  const clickedAt = new Date();
  // ... trigger the resend here ...

  try {
    const message = await inbox.waitForMessage({
      after: clickedAt, // explicit high-water mark; the default is mailbox createdAt
      match: (m) => m.attachmentCount === 0,
      signal: AbortSignal.timeout(90_000), // an outer kill switch, independent of timeoutMs
    });

    console.log(`from:  ${message.from}`);
    console.log(`addr:  ${message.fromAddress ?? "(unparseable)"}`);
    console.log(`codes: ${message.verificationCodes.join(", ") || "(none)"}`);
    console.log(`links: ${message.links().map((u) => u.href).join("\n       ")}`);
    // `text` falls back to the raw HTML source when the mail carried no
    // text/plain part, so do not assume it is free of markup.
    console.log(`text:  ${message.text?.slice(0, 200) ?? "(none)"}`);
  } catch (err) {
    if (!NowTempMailError.is(err) || err.code !== "timeout") throw err;
    console.warn("no follow-up message arrived");
  }

  /* ---------------------------------------------------------------- *
   * 3. History. messages.list() auto-paginates; do NOT use it to watch a
   *    live inbox. Messages are newest-first, so new mail lands at the front
   *    of page one and a cursor walk started earlier can miss it entirely.
   *    That is what waitFor* is for — it re-reads page one and dedupes by id.
   * ---------------------------------------------------------------- */

  let total = 0;
  for await (const summary of inbox.messages.list({ limit: 100 })) {
    total += 1;
    console.log(
      `${summary.receivedAt.toISOString()} ${summary.from} | ${summary.subject}` +
        ` | ${summary.attachmentCount} attachment(s)`,
    );
  }
  console.log(`${total} message(s) in history`);

  /* ---------------------------------------------------------------- *
   * 4. One page at a time, if you are driving the cursor yourself.
   * ---------------------------------------------------------------- */

  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await inbox.messages.page({ limit: 25, cursor });
    pages += 1;
    console.log(`page ${pages}: ${page.messages.length} message(s), hasMore=${page.hasMore}`);
    // The cursor is opaque. Pass it back verbatim; never parse it.
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  console.log(`rate limit remaining: ${ntm.metering.rateLimit?.remaining ?? "unknown"}`);
  await inbox.delete();
}

main().catch((err: unknown) => {
  console.error(NowTempMailError.is(err) ? err.toLogString() : err);
  process.exitCode = 1;
});
