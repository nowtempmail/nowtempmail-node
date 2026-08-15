/**
 * Playwright: sign up, read the OTP out of the mailbox, verify.
 *
 *   npm i -D @playwright/test
 *   export NTM_API_KEY="ntm_test_..."
 *   npx playwright test examples/playwright-signup.spec.ts
 *
 * Import `test` and `expect` from "nowtempmail/playwright" instead of
 * "@playwright/test". It is the same `test`, extended with four fixtures.
 *
 * The thing worth internalising: `inbox` is WORKER-SCOPED. One mailbox is shared
 * by every test that worker runs, and it is not deleted at teardown. That is not
 * an optimisation, it is a quota constraint — deleting a mailbox refunds nothing
 * against the 50/day Free ceiling, so a per-test mailbox turns a 50-test suite
 * into a whole day of quota in one CI run.
 *
 * Sharing is safe because every wait is watermarked: an auto fixture re-stamps
 * the boundary at the start of each test, so `waitForCode()` cannot resolve with
 * a code an earlier test triggered. You do not need `ignoreExisting`.
 */

import { test, expect } from "nowtempmail/playwright";

// Client options for the whole file. NTM_API_KEY comes from the environment.
test.use({ ntmOptions: { timeoutMs: 45_000 } });

test("a new user verifies their email address", async ({ page, inbox }) => {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(inbox.address);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  // No `after`, no `ignoreExisting`: the filter's boundary already defaults to
  // this test's watermark. `from` is still worth adding — the watermark has
  // one-second resolution, so it cannot separate two tests in this file that
  // trigger mail from the same sender inside the same second.
  const code = await inbox.waitForCode({
    from: "noreply@myapp.example",
    timeoutMs: 60_000,
  });

  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
});

test("resending replaces the previous code", async ({ page, inbox }) => {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(inbox.address);
  await page.getByRole("button", { name: "Create account" }).click();

  const first = await inbox.waitForCode();

  // Here an explicit boundary IS needed, and it is not about the shared inbox:
  // both codes belong to this test, so both are inside the watermark. On a
  // resend flow the stale code is the bug, so anchor to the moment before the
  // click. An explicit `after` always wins over the fixture's watermark.
  const clickedAt = new Date();
  await page.getByRole("button", { name: "Resend code" }).click();
  const second = await inbox.waitForCode({ after: clickedAt });

  expect(second).not.toBe(first);
});

test("the password reset link works", async ({ page, inbox }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(inbox.address);
  await page.getByRole("button", { name: "Send reset link" }).click();

  // waitForMessage is watermarked exactly like waitForCode, and unlike it does
  // fetch the body — which is what links() needs.
  const message = await inbox.waitForMessage({
    subject: /reset your password/i,
  });

  // links() dedupes across the text and html parts and preserves order.
  const reset = message.links().find((url) => url.pathname.startsWith("/reset"));
  expect(reset, `no /reset link in: ${message.links().map((u) => u.href).join(", ")}`).toBeDefined();

  await page.goto(reset!.href);
  await page.getByLabel("New password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();
});

/**
 * `freshInbox` is per-test and gets its own address, created before the test and
 * deleted after it. It costs one mailbox from the daily quota every time this
 * test runs and the quota is never refunded, so use it only when the test
 * genuinely needs an address no other test has touched — as here, where the
 * assertion is about an address being seen for the first time.
 *
 * It needs no watermark: every message in it belongs to this test by
 * construction, so its waits anchor to the mailbox's own createdAt.
 */
test("signing up twice with the same address is rejected", async ({ page, freshInbox }) => {
  for (const attempt of [1, 2]) {
    await page.goto("/signup");
    await page.getByLabel("Email").fill(freshInbox.address);
    await page.getByRole("button", { name: "Create account" }).click();

    if (attempt === 1) {
      await expect(page.getByText("Check your email")).toBeVisible();
    } else {
      await expect(page.getByText("That email is already registered")).toBeVisible();
    }
  }
});

test("the account survives its own quota reporting", async ({ ntm }) => {
  // The `ntm` fixture is the client, worker-scoped. /v1/me is metered in peek
  // mode, so reading it never consumes the quota it is reporting on.
  const account = await ntm.me();
  expect(account.usage.mailboxesRemainingToday).toBeGreaterThan(0);
});
