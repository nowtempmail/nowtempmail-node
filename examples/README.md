# Examples

Five complete programs. Each one runs on its own; none of them is a fragment.

They are **not** part of the published tarball (`package.json` ships `dist`,
`README.md`, `LICENSE` and `CHANGELOG.md` only) and they are outside the
`tsconfig.json` `include`, so `npm run typecheck` does not compile them. They are
written against the same signatures the package exports.

## Running them

```bash
export NTM_API_KEY="ntm_test_..."      # https://nowtempmail.com/developers/keys
npm run build                          # examples import "nowtempmail", which resolves to dist/
npx tsx examples/signup-otp.ts
```

Use a `ntm_test_...` key. It is metered against the Free plan whatever you pay,
which is exactly what you want while you are learning the shape of things. It is
not a data sandbox — it creates real mailboxes that receive real mail.

Two of them need something extra:

```bash
npm i -D @playwright/test              # playwright-signup.spec.ts
npm i express                          # webhook-receiver.ts
```

| File | What it demonstrates |
|---|---|
| [`signup-otp.ts`](./signup-otp.ts) | The whole flow, and the error branches that actually matter: `mailbox_may_exist`, `timeout` with `messagesSeen`, `confirmed: false`. |
| [`playwright-signup.spec.ts`](./playwright-signup.spec.ts) | `inbox` vs `freshInbox`, when the per-test watermark is enough and when you still need an explicit `after`, and `message.links()` for a reset flow. |
| [`webhook-receiver.ts`](./webhook-receiver.ts) | `express.raw()`, `verifyWebhook()`, ack-then-work, dedupe on `event.id`, and fetching the message the pointer refers to. |
| [`custom-filter.ts`](./custom-filter.ts) | `match` predicates, explicit `after` marks, `messages.list()` for history, and manual cursor paging. |
| [`attachment-download.ts`](./attachment-download.ts) | `attachment.download()`, and treating the sender-supplied filename as hostile. |

## Three things every example is careful about

**Quota is spent on creation and never refunded.** `POST /v1/mailboxes` is the
only metered endpoint. Deleting a mailbox does not give the mailbox back — Free
is 50 per UTC day and that counter only goes up. Every example that creates a
mailbox creates exactly one, and the Playwright example reuses a worker-scoped
one on purpose — its one `freshInbox` test is the exception, and it says why.

**Filter before you trust a code.** `verificationCodes` is a documented
heuristic. It looks for 4-8 digit numeric and 6-10 character uppercase
alphanumeric codes near a word like *code* or *otp*, which a promotional footer
satisfies just as well as your OTP does. `signup-otp.ts` and `custom-filter.ts`
both narrow by `from` and `subject` first.

**Branch on `err.code`.** Never `instanceof`. The package is dual-published, a
consumer can load an ESM copy and a CJS copy at once, and `instanceof` then
returns `false` without any symptom other than a skipped error branch. Every
example uses `NowTempMailError.is(err)` followed by a check on `err.code`.

## Not shown here

Reservations (`ntm.reservations.list()` / `.release()`), custom addresses and
`ttlSeconds` beyond 24h are Starter/Scale capabilities. Asking for one on Free
comes back as `402 plan_upgrade_required` with `parameter` naming the field —
never a silent downgrade — so an example would only ever demonstrate the error.
