/**
 * The whole flow, end to end: create a mailbox, trigger a signup, read the code.
 *
 *   export NTM_API_KEY="ntm_test_..."
 *   npx tsx examples/signup-otp.ts
 *
 * What this example is really about is the error handling. The happy path is
 * four lines; the interesting part is that `quota_exceeded` and
 * `mailbox_may_exist` need genuinely different responses, and neither of them is
 * "retry the create".
 */

import { NowTempMail, NowTempMailError, type Mailbox } from "nowtempmail";

const ntm = new NowTempMail({
  // Both hooks are optional. Neither ever sees the Authorization header.
  onResponse: ({ method, path, status, durationMs }) => {
    console.log(`  ${method} ${path} -> ${status} (${durationMs}ms)`);
  },
  onLowQuota: ({ remaining, limit, reset }) => {
    console.warn(
      `  !! ${remaining}/${limit} mailboxes left today, resets ${reset.toISOString()}`,
    );
  },
});

/** Stand-in for whatever your application does when someone signs up. */
async function signUpMyApp(address: string): Promise<void> {
  console.log(`  (pretend we POSTed a signup for ${address})`);
}

async function main(): Promise<void> {
  const account = await ntm.me();
  console.log(
    `key ${account.keyId} on ${account.plan.label}: ` +
      `${account.usage.mailboxesRemainingToday}/${account.plan.mailboxesPerDay} mailboxes left today`,
  );

  let inbox: Mailbox;
  try {
    // No arguments: a generated address on the default domain, alive 24h. That
    // 24h default is the same on every plan.
    inbox = await ntm.mailboxes.create();
  } catch (err) {
    if (NowTempMailError.is(err) && err.code === "mailbox_may_exist") {
      // The request left this process and then transport failed. A mailbox may
      // exist that we will never know the address of, with quota already spent.
      // Retrying blindly spends a second one, so: don't.
      console.error("Mailbox creation failed in transport. Check ntm.me() before retrying.");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(`mailbox: ${inbox.address}`);
  console.log(`expires: ${inbox.expiresAt.toISOString()} (in ${Math.round(inbox.expiresInMs / 1000)}s)`);

  if (!inbox.confirmed) {
    // create() tries three times to read the mailbox back before resolving,
    // because the mail receiver drops inbound mail permanently if the inbox is
    // not yet visible. `false` means it is probably fine but was slow to read.
    console.warn("mailbox was not confirmed readable — very early mail may be lost");
  }

  await signUpMyApp(inbox.address);

  try {
    const code = await inbox.waitForCode({
      // Narrow it. `verificationCodes` is a heuristic and a marketing footer
      // with "use code SAVE20" in it will match just as happily as your OTP.
      from: "noreply@myapp.example",
      subject: /verify/i,
      timeoutMs: 90_000,
    });
    console.log(`code: ${code}`);
  } catch (err) {
    if (NowTempMailError.is(err) && err.code === "timeout") {
      // TimeoutError carries what it did see, which is the part that tells you
      // whether the mail never arrived or arrived and did not match the filter.
      // Read the extra field off the branded error rather than narrowing with
      // `instanceof TimeoutError`, which is unreliable across ESM/CJS copies.
      const seen = (err as { messagesSeen?: number }).messagesSeen ?? 0;
      console.error(`no matching code in ${inbox.address}; ${seen} message(s) seen`);
      for await (const summary of inbox.messages.list({ limit: 25 })) {
        console.error(`  - ${summary.from} | ${summary.subject} | ${summary.verificationCodes}`);
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Optional. The mailbox expires by itself in 24h, and deleting it refunds no
  // quota at all — do it only when you want the data gone now.
  const { deletedMessages } = await inbox.delete();
  console.log(`deleted, ${deletedMessages} message(s) removed`);
}

main().catch((err: unknown) => {
  if (NowTempMailError.is(err)) {
    // toLogString() is guaranteed free of credential material.
    console.error(err.toLogString());
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
