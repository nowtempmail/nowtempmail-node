# nowtempmail

Disposable mailboxes and OTP codes for your tests. Verification codes are extracted server-side at ingest, so there is no regex to write.

```bash
npm install nowtempmail
```

```ts
import { NowTempMail } from "nowtempmail";

const ntm = new NowTempMail();            // reads NTM_API_KEY
const inbox = await ntm.mailboxes.create();
await signUpMyApp(inbox.address);
const code = await inbox.waitForCode();   // "482913"
```

**Zero dependencies** · **Node >= 20** · **TypeScript types included** · **ESM + CJS**

---

## Server-side only

`/v1` sends no CORS headers and **rejects any request carrying an `Origin` header with `403 origin_not_allowed`, before it even reads your key.** There is no allowlist to be added to, and there is no configuration that changes this.

An API key in browser JavaScript is a published key — and it would not work anyway. Call this from your test runner, your CI job, or your own backend. If a browser needs the data, put your own endpoint in front of it.

The SDK refuses to construct in a real browser and throws `BrowserUseRefusedError`. The check is deliberately narrow (`document` present, `process.versions.node` absent), so a jsdom or happy-dom test environment is unaffected. `dangerouslyAllowBrowser: true` exists to unblock an exotic runtime that is misdetected, not to make browser calls work — they will still be rejected at the edge.

## Get a key

Sign in with GitHub at [nowtempmail.com/developers/keys](https://nowtempmail.com/developers/keys). The secret is shown once and stored only as a hash.

```bash
export NTM_API_KEY="ntm_live_..."
```

`ntm_test_...` keys **will** be metered against the Free plan once billing goes live. While `paywall.enabled` is `false` — which it is today — they resolve to the launch plan like every other key and get the same limits. Either way they are not a data sandbox: a test key creates real mailboxes that receive real mail.

Every option is explicit if you would rather not use the environment variable:

```ts
const ntm = new NowTempMail({
  apiKey: process.env.MY_KEY,
  timeoutMs: 30_000,          // per request
  maxRetries: 2,              // GET and DELETE only — never mailbox creation
  userAgentSuffix: "acme-e2e/3.1",
});
```

`new NowTempMail("ntm_live_...")` is shorthand for `{ apiKey: "..." }`.

## Playwright

The primary use case. `nowtempmail/playwright` re-exports `test` and `expect` with four extra fixtures.

```ts
import { test, expect } from "nowtempmail/playwright";

test("a new user verifies their email address", async ({ page, inbox }) => {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(inbox.address);
  await page.getByRole("button", { name: "Create account" }).click();

  // Only this test's mail is a candidate. See "Watermarking" below.
  const code = await inbox.waitForCode();

  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Welcome")).toBeVisible();
});
```

| Fixture | Scope | Notes |
|---|---|---|
| `inbox` | worker | One mailbox, reused by every test in the worker, and **not deleted on teardown** — the quota is spent either way, and leaving it to expire means a post-mortem can still read what arrived. The default, on purpose. |
| `freshInbox` | test | Its own mailbox, created before the test and deleted after it. **Costs one mailbox from your daily quota per test, and that is never refunded.** Opt in only when a test genuinely cannot share: asserting on an empty inbox, deleting messages a sibling test needs, needing a different domain or TTL, or a suite long enough to fill the shared mailbox — see below. |
| `ntm` | worker | The `NowTempMail` client, if you need `ntm.me()` or a second mailbox. |
| `ntmOptions` | worker | The option fixture. Override with `test.use({ ... })`. |

`inbox` and `freshInbox` are a `TestInbox`, not a bare `Mailbox`: `address`, `createdAt`, `expiresAt`, `expired`, `expiresInMs`, `messageCount`, `confirmed`, `messages`, `refresh()`, `delete()` and a `page()` shortcut are forwarded, and `waitForCode()` / `waitForMessage()` add watermarking and trace attachment. `inbox.mailbox` is the unwrapped handle for anything not forwarded.

**A shared mailbox fills up, and that is the one reason not to share one indefinitely.** Every mailbox has a per-inbox message cap — 50 on Free, 200 on Starter, 1,000 on Scale — and once a mailbox has received that many, further mail is **dropped, not rejected**: no error, no header, nothing in `/v1` that says so. See [Rate limits and quota](#rate-limits-and-quota). The `inbox` fixture is exactly the thing that accumulates, because every test in the worker sends to it, and deleting messages does not free capacity — the counter is of mail received, not mail held. When it fills, `waitForCode()` times out with `messagesSeen > 0`, which is the least debuggable outcome available.

Watch `inbox.messageCount` (or page through `inbox.messages`) if a worker runs hundreds of mail-sending tests, and use `freshInbox` — or a second mailbox from the `ntm` fixture — for the tests that generate the most mail. Sharding across Playwright workers helps on its own: each worker gets its own `inbox`.

### Watermarking

A shared mailbox means test #7 could resolve with the code test #3 triggered, and the suite would go green while testing nothing. So `waitForCode()` and `waitForMessage()` default the filter's `after` to a per-test watermark, re-stamped by an auto fixture at the start of every test. You do not need `ignoreExisting`.

The watermark is the test's start instant **minus a 1s skew, floored to the second**. Both halves matter: `receivedAt` on the wire is second-granular and a CI runner's clock is not the API's clock, so a watermark placed at exactly the start instant can sit *after* the timestamp of mail that test caused — which surfaces as a timeout with `messagesSeen > 0`, the least debuggable outcome available.

**The honest caveat:** two tests in one file that trigger mail from the same sender inside the same second can still collide, because a 1s window cannot separate them. Disambiguate on content when that is possible — add `from` or `subject` to the filter. An explicit `after`, or `ignoreExisting: true`, still wins over the watermark.

`freshInbox` needs none of this: its watermark is the mailbox's own `createdAt`, because every message in it belongs to that test by construction.

### Configuration

Reads `NTM_API_KEY` from the environment. Everything else goes through `ntmOptions`, which accepts all of [`ClientOptions`](#get-a-key) — `apiKey` included, if you would rather set the key here than in the environment — plus three fixture-only keys: `attachBody`, `mailbox` (a `CreateMailboxParams` for both inbox fixtures), and `watermarkSkewMs`.

```ts
// playwright.config.ts, or any spec file
test.use({ ntmOptions: { timeoutMs: 45_000, mailbox: { ttlSeconds: 3_600 } } });
```

On a match the fixtures attach what they saw to the Playwright report, **redacted by default**: subject, sender, `receivedAt`, the extracted codes, and counts of the links and body characters withheld. `ntmOptions.attachBody: true` adds bodies and link URLs. Think before you turn that on — a trace is zipped into a CI artifact, downloaded by anyone with repo read access, and pasted into issues, and a password-reset link inside one is a live credential with a working expiry. The codes are attached deliberately: a verification code is single-use and already spent by the time anyone reads the trace, and it is the one value you cannot debug an OTP flow without.

`@playwright/test` is an optional peer, loaded lazily. Importing this module in a project that never installed it does not throw; the error arrives, explaining itself, only when a fixture is used. `playwrightAvailable` is exported for diagnostics.

## Cypress, Vitest, Jest

Anything that runs in Node works directly.

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { NowTempMail, type Mailbox } from "nowtempmail";

const ntm = new NowTempMail();
let inbox: Mailbox;

beforeAll(async () => {
  inbox = await ntm.mailboxes.create();
});

afterAll(async () => {
  await inbox.delete();
});

test("signup emails a six-digit code", async () => {
  await signUpMyApp(inbox.address);
  const code = await inbox.waitForCode({ ignoreExisting: true });
  expect(code).toMatch(/^\d{6}$/);
});
```

Cypress specs run in the browser, so the client has to live on the Node side of the harness and be reached through `cy.task`:

```ts
// cypress.config.ts
import { defineConfig } from "cypress";
import { NowTempMail } from "nowtempmail";

const ntm = new NowTempMail();

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      on("task", {
        async createInbox() {
          const inbox = await ntm.mailboxes.create();
          return inbox.address;
        },
        async waitForCode({ address, since }: { address: string; since: number }) {
          // attach() builds a handle with no network call, so its createdAt reads
          // as the epoch — which means the default watermark accepts EVERY message
          // already in the inbox. Always pass `after` or `ignoreExisting` here.
          return ntm.mailboxes.attach(address).waitForCode({ after: new Date(since) });
        },
      });
    },
  },
});
```

```ts
// cypress/e2e/signup.cy.ts
it("verifies a new account", () => {
  const since = Date.now();
  cy.task<string>("createInbox").then((address) => {
    cy.visit("/signup");
    cy.get("[name=email]").type(address);
    cy.contains("button", "Create account").click();
    cy.task<string>("waitForCode", { address, since }, { timeout: 90_000 }).then((code) => {
      cy.get("[name=code]").type(code);
    });
  });
});
```

Give `cy.task` a timeout larger than `waitForCode`'s own (60s by default), or Cypress kills the task before the SDK gives up and you lose the useful error.

## CLI

Two binaries ship with the package: `nowtempmail` and `nowtempmail-mcp` — and the MCP server is also reachable as `nowtempmail mcp`, which is the form the [MCP](#mcp) section documents. Both read the key from `NTM_API_KEY` and nothing else — there is no `login` command and no config file, because a key on a command line ends up in `ps` output and shell history.

```bash
# Create a mailbox. The address is the only thing on stdout.
ADDR=$(npx nowtempmail new)

# Block until a verification code lands, print just the code.
CODE=$(npx nowtempmail code "$ADDR" --from github --wait 90)

# Or both in one call: address on the first stdout line, code on the second.
npx nowtempmail new --wait-code

# Follow an inbox. Existing mail is not replayed; ⌃C stops it.
npx nowtempmail tail "$ADDR"

# Inspect
npx nowtempmail ls "$ADDR" --limit 5
npx nowtempmail whoami          # alias: me
npx nowtempmail domains
npx nowtempmail rm "$ADDR"      # tells you quota is not refunded
```

| Command | Flags |
|---|---|
| `new` | `--domain <domain>` `--ttl <seconds>` `--address <local>` `--wait-code` `--wait <seconds>` |
| `code <address>` | `--wait <seconds>` (alias `--timeout`) `--from <text>` `--subject <text>` |
| `tail <address>` | — |
| `ls <address>` | `--limit <n>` |
| `rm <address>` | — |
| `whoami` (alias `me`) | — |
| `domains` | — |
| `mcp` | The MCP stdio server. Its own flag set — see [MCP](#mcp) |

Global flags, accepted on every command: `--base-url <url>` (also read from `NTM_BASE_URL`), `--json`, `--no-color`, `--help` / `-h`. `--version` / `-V` works as the first argument. `nowtempmail help <command>` is equivalent to `nowtempmail <command> --help`.

`mcp` is the exception to that table: it hands everything after it straight to the MCP server, which has its own flags, so `nowtempmail mcp --help` and `nowtempmail mcp --version` print the *server's* help and version rather than the CLI's.

`--from` and `--subject` are case-insensitive **substring** matches on the raw header, not regexes — the shell would eat the slashes anyway. `--wait` defaults to 60 seconds. Integer flags reject anything that is not a positive whole number rather than silently rounding, because a typo'd `--wait` that blocks a CI job for the default 60s is worse than a hard failure.

**Every command puts its payload on stdout and everything else on stderr**, so `CODE=$(nowtempmail code …)` captures the bare code and nothing else. Expiry, remaining quota, poll interval, rate-limit notices and timeout messages all go to stderr. `--json` switches stdout to one JSON object (`tail` emits one object per line). The key is scrubbed from every stream, including under `--json`, and `whoami` prints the key id — the short public identifier — never the secret.

### Exit codes

A shell script branches on these, so they are as much a part of the interface as the output is.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | An API or runtime failure — including `quota_exceeded`, a suspended account, a connection failure, and `mailbox_may_exist` |
| `2` | Usage: a bad flag, a missing `<address>`, no `NTM_API_KEY`, a rejected or revoked key, a bad `--base-url`, **and `invalid_request` (422)** — the API complaining about a value means the user typed a bad one, which is usage, not a fault |
| `4` | A `code` or `new --wait-code` wait elapsed with no match. Distinct from `1` on purpose: "no mail arrived" and "your key is revoked" need different handling in a script |
| `130` | ⌃C during `code` or `new --wait-code` |

`tail` has no deadline, so it never exits `4`, and it exits `0` on ⌃C — it ran until you stopped it, which is what you asked for. `code` and `new --wait-code` exit `130` instead, because they were asked for one specific value and did not produce it: returning `0` with empty stdout would read as success to `CODE=$(…)`, and the script would carry on with an empty code.

A timed-out wait says which of the two things happened — `no code in 60s — no messages arrived` versus `no code in 60s — 2 messages arrived, none carried a code`. That distinction is the first thing anyone debugging a flaky signup wants, and it is why `TimeoutError` carries `messagesSeen`.

A rate limit is not a failure. The SDK waits out the window, the CLI prints an amber `rate limited — resuming in Ns (30/min on Free)` line to stderr, and the command continues.

`code` fetches the mailbox with one `GET` before it starts waiting. That turns a typo'd address into `no mailbox …` immediately instead of a 60-second wait, and it gives the poller the mailbox's real `createdAt` as its high-water mark — so a code that landed *before* you ran the command is still found.

Other environment variables: `NTM_BASE_URL`, `NO_COLOR` (and `TERM=dumb`) to disable colour, `NTM_POLL_INTERVAL_MS` to override the derived poll interval. Colour is emitted only when stdout is a TTY, so piped output is always plain.

Run `npx nowtempmail --help` or `nowtempmail help <command>` for the authoritative list; the binary generates its help from the same table the parser uses, so a flag cannot exist in one and be missing from the other.

## Webhooks

A Starter and Scale capability on paper — **and available to every account today**, because the paywall is off. While `ntm.me()` reports `paywall.enabled: false`, `webhookUrl` is accepted on any key regardless of plan; it starts returning `402 plan_upgrade_required` on Free only once billing goes live. See [Rate limits and quota](#rate-limits-and-quota).

Register by passing `webhookUrl` when you create a mailbox — there is no separate endpoint. The same URL on the same key reuses one endpoint with one health record.

```ts
const inbox = await ntm.mailboxes.create({
  webhookUrl: "https://example.com/hooks/nowtempmail",
});
```

`nowtempmail/webhooks` does not import the client and uses `crypto.subtle` rather than `node:crypto`, so it runs unchanged on Node, Cloudflare Workers, Deno and Bun. It exports `verifyWebhook`, `isValidWebhookSignature`, `WebhookSignatureError`, `WebhookConfigError` and `NowTempMailError` — you do not need the root entry to handle its errors.

```ts
import express from "express";
import { NowTempMailError, verifyWebhook } from "nowtempmail/webhooks";

const app = express();

// The RAW body. express.json() would reparse and reserialise it, and the
// digest is over the exact bytes we sent.
app.post("/hooks/nowtempmail", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook({
      rawBody: req.body,
      signature: req.get("X-NTM-Signature"),
      secret: process.env.NTM_WEBHOOK_SECRET!,
    });
  } catch (err) {
    console.error(NowTempMailError.is(err) ? err.toLogString() : err);
    return res.sendStatus(400);
  }

  // At-least-once delivery. event.id equals X-NTM-Delivery and is stable
  // across every retry of the same message — dedupe on it.
  res.sendStatus(200);                 // ack first
  await enqueue(event.data.messageId, event.data.address);   // work after
});
```

`verifyWebhook` throws `WebhookConfigError` for a missing or blank secret — before it computes anything, because WebCrypto will happily import a zero-length key and `String(undefined)` is a perfectly good one, and either way you get a verifier that no test written against a real signature would catch. `WebhookSignatureError` means that request did not verify. `isValidWebhookSignature` is the same check returning a boolean, for when you do not want the parsed event.

The tolerance check is symmetric — `|now - t| > tolerance` rejects a future-dated timestamp as well as a stale one, so a receiver whose clock runs slow cannot be fed arbitrarily old replays. Unknown schemes in the header (`v2=`) are tolerated so a future digest migration is not a breaking change, and every `v1` candidate is compared in constant time with no early exit.

The payload is a **pointer, not the mail**: `messageId`, `address`, `receivedAt`, nothing else. No subject, no sender, no body, no codes. Reading the message needs your API key, which never crosses your callback URL. Fetch it out of band:

```ts
const message = await ntm.mailboxes.attach(event.data.address).messages.get(event.data.messageId);
console.log(message.code);
```

`event.createdAt` and `event.data.receivedAt` are both `Date` on the parsed `WebhookEvent`, which is worth knowing if you ever read the raw JSON instead: **on the wire those two fields use different units.** `createdAt` is Unix *seconds* — it is the same `t` that is inside the signature — while `data.receivedAt` is Unix *milliseconds*, passed straight through from the queue message. The SDK normalises both, so `verifyWebhook` is the version of this you want to be using.

Delivery: 10s timeout per attempt, redirects **not** followed, retried with jitter to a 5-minute ceiling, auto-disabled after 20 consecutive failed attempts (retries count; any 2xx resets the streak). Endpoint health lives on `ntm.me()` under `webhookEndpoints` — check `disabledReason` there first when deliveries go quiet, because it is the only place the auto-disable decision is visible, and nothing re-enables an endpoint on its own. `ntm.webhooks.test()` queues a real signed delivery through the identical path — same queue, same signer, same guard — so you can prove your verifier works before real mail depends on it. Tell a test event apart by the `test_` prefix on `data.messageId`; there is no message behind it and fetching it returns 404.

The signing secret (`whsec_…`) is per API key and minted alongside it. **It is shown once, on the screen that creates the key, and never again** — the same screen as the key itself, and subject to the same rule. No `/v1` response carries it and nothing in the developer portal reads it back, so store it wherever you stored the key, at the moment you store the key. If you no longer have it, create a new key or ask support; there is nowhere to look it up.

## MCP

`nowtempmail mcp` exposes the mailbox as tools to an MCP client, so an agent can sign itself up for things.

```json
{
  "mcpServers": {
    "nowtempmail": {
      "command": "npx",
      "args": ["-y", "nowtempmail@0.1.1", "mcp"],
      "env": { "NTM_API_KEY": "${NTM_API_KEY}" }
    }
  }
}
```

**The package is `nowtempmail` and `mcp` is a subcommand of it.** `npx -y nowtempmail-mcp` does not work and never did: npx resolves a *package* name, and `nowtempmail-mcp` is the name of a second bin inside this package, not a package of its own. 0.1.0's README got this wrong; it 404s. If you prefer the bin directly, `-p` is what tells npx which package to take it from:

```jsonc
// Equivalent, for anyone who wants the bin rather than the subcommand.
"args": ["-y", "-p", "nowtempmail@0.1.1", "nowtempmail-mcp"]
```

Both forms run the same server. `nowtempmail mcp --help` and `nowtempmail mcp --version` print the server's own help and version and exit immediately, without opening a transport or needing a key — which makes them the smoke test to run when a client reports the server as unhealthy.

Pin the version and keep the `${NTM_API_KEY}` indirection. `.mcp.json` gets committed, so a literal key in it is a published key — and `npx -y` on a floating version is a fresh download of whatever was published this morning executed with your key in its environment.

Four tools by default:

| Tool | Returns |
|---|---|
| `create_mailbox` | address and expiry. Args: `domain`, `ttlSeconds` |
| `list_messages` | id, from, subject, `receivedAt`, codes. Args: `address`, `limit` (1–50, default 10) |
| `get_code` | one verification code, shape-checked before it is returned. Args: `address`, `from`, `subject`, `ignoreExisting`, `timeoutMs` (1000–180000, default 60000) |
| `delete_mailbox` | confirmation. Says that quota is not refunded |

The default surface deliberately returns **no message bodies, no HTML and no links**. Inbound email is attacker-controlled text and these returns land straight in a model's context, so a shape-constrained return is the mitigation: `get_code` refuses to return anything that is not code-shaped, and sender and subject are defanged and truncated to 200 characters.

`read_message` is registered only when the server is started with `--allow-body-read`. HTML is stripped to text, and the `From` header, the `Subject` header and the body are truncated **together** at 2000 characters — the headers are inside the budget, not additional to it — then fenced in an explicit untrusted-content block.

Flags: `--allow-body-read`, `--max-mailboxes <n>` (default 10), `--base-url <url>`, `-h` / `--help`, `-v` / `--version`. They go after the subcommand — `nowtempmail mcp --allow-body-read --max-mailboxes 5` — and reach the server untouched, which in a client config means `"args": ["-y", "nowtempmail@0.1.1", "mcp", "--allow-body-read"]`. The mailbox cap is per server process — mailbox creation is the only quota-consuming call and deletion never refunds it, so the cap is what stops a looping agent from spending a whole day's allowance in a minute. Raising it means restarting the server, which is the point.

The key is read from `NTM_API_KEY` only and is never accepted as a flag. Once the transport is up, nothing but protocol frames go to stdout; diagnostics go to stderr.

## Errors

Every failure is an `application/problem+json` document ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) mapped to a class, and every error that reached the wire carries a `requestId`. That is the first thing support will ask for.

**Branch on `err.code`, or use `NowTempMailError.is(err)`. Do not use `instanceof`.** This package is dual-published as ESM and CJS, so a consumer can end up with two copies of these classes loaded at once — an ESM Playwright fixture and a CJS application helper, say. `instanceof` then silently returns `false`, your error branch is skipped, and nothing looks wrong. `NowTempMailError.is()` checks a `Symbol.for()` brand, which is registry-global and agrees across both copies.

```ts
import { NowTempMailError } from "nowtempmail";

try {
  const inbox = await ntm.mailboxes.create({ ttlSeconds: 604_800 });
} catch (err) {
  if (!NowTempMailError.is(err)) throw err;

  switch (err.code) {
    case "plan_upgrade_required":
      // err.parameter names the field; err.maxTtlSeconds is your ceiling.
      console.error(`${err.parameter} exceeds the ${err.plan} plan`);
      break;
    case "quota_exceeded":
      console.error(`Out of mailboxes. Retry in ${err.retryAfter}s.`);
      break;
    case "mailbox_may_exist":
      // The request left the machine and then transport failed. Quota may be
      // spent on a mailbox you never learned the address of. Check ntm.me().
      break;
    default:
      console.error(err.toLogString());   // never contains your key
      throw err;
  }
}
```

| `code` | Class | HTTP | What it means |
|---|---|---|---|
| `unauthorized` | `UnauthorizedError` | 401 | No credential, or a malformed `Authorization` header |
| `invalid_key` | `InvalidKeyError` | 401 | Not recognised — usually a truncated copy/paste |
| `key_revoked` | `KeyRevokedError` | 401 | Rotate it. Not retryable |
| `account_suspended` | `AccountSuspendedError` | 403 | The whole account is suspended |
| `forbidden` | `ForbiddenError` | 403 | Authenticated but not permitted. Reserved: no endpoint emits it in this release |
| `origin_not_allowed` | `OriginNotAllowedError` | 403 | You sent an `Origin` header. You are calling from a browser |
| `plan_upgrade_required` | `PlanUpgradeRequiredError` | 402 | A paid capability, or a `ttlSeconds` that failed validation |
| `not_found` | `NotFoundError` | 404 | Gone, expired, or belongs to another key — indistinguishable on purpose |
| `address_taken` | `AddressTakenError` | 409 | Live elsewhere, or reserved by someone else. Which one is not disclosed |
| `address_reserved` | `AddressReservedError` | 409 | Defined in the vocabulary; no endpoint emits it in this release |
| `invalid_request` | `InvalidRequestError` | 422 | Check `err.parameter` |
| `rate_limit_exceeded` | `RateLimitExceededError` | 429 | Sleep exactly `err.retryAfter` seconds |
| `quota_exceeded` | `QuotaExceededError` | 429 | No mailboxes left until 00:00 UTC |
| `internal_error` | `InternalError` | 500 | Retry with backoff, quote `err.requestId` |
| `timeout` | `TimeoutError` | — | A `waitFor*` gave up. Carries `messagesSeen`, `waitedMs`, `address` |
| `connection_error` | `ConnectionError` | — | DNS, TLS, socket, or an aborted request |
| `mailbox_may_exist` | `MailboxMayExistError` | — | Mailbox creation failed *after* the request was sent |
| `browser_use_refused` | `BrowserUseRefusedError` | — | Constructed in a real browser |
| `webhook_signature` | `WebhookSignatureError` | — | Digest did not verify, or is outside the tolerance window |
| `webhook_config` | `WebhookConfigError` | — | The verifier was called with an unusable secret |
| `config_error` | `ConfigError` | — | No API key, a non-https `baseUrl`, and similar |

`err.retryable` is `true` for `rate_limit_exceeded`, `internal_error` and `connection_error`. An unrecognised code from a newer server becomes a base `NowTempMailError` with the code passed through, rather than a crash.

`POST /v1/mailboxes` is **never** retried automatically. It is the only quota-consuming endpoint and the API has no idempotency key, so a blind retry can silently burn two mailboxes for one logical call. A transport failure there surfaces as `MailboxMayExistError`; everything else retries `maxRetries` times on GET and DELETE only.

## Rate limits and quota

Three ceilings. Two are counted exactly per API key and reported back in response headers; the third is per mailbox and is reported nowhere.

| Plan | Requests/min | Mailboxes/day | Messages/inbox | Custom address | Reserved | Webhooks | Max `ttlSeconds` |
|---|---|---|---|---|---|---|---|
| Free | 30 | 50 | 50 | — | 0 | — | 86,400 (24h) |
| Starter | 300 | 2,000 | 200 | yes | 5 | yes | 604,800 (7 days) |
| Scale | 1,200 | 25,000 | 1,000 | yes | 100 | yes | 2,592,000 (30 days) |

**That table is the post-billing state, not what you get today.** While `paywall.enabled` is `false` — which it is right now — every account receives the launch plan's limits and **all four gated capabilities**: custom addresses, reserved addresses, extended TTL and webhooks. `402 plan_upgrade_required` does not occur for those capabilities today, whatever tier your account is on. The numeric ceilings above are still enforced, at the launch plan's values, because they are abuse control rather than price discrimination — a `ttlSeconds` over the ceiling is still a `402`.

Read `ntm.me()` rather than inferring anything from your key prefix or your plan id: `plan` is what you actually have, and `paywall.enabled` is where the change will show up first when billing goes live.

**Free is 30 requests per minute across the whole API**, not per mailbox and not per endpoint — every call the SDK makes shares that budget. Polling one mailbox every two seconds is fine; polling four at that rate is not. `waitForCode` derives its own poll floor from the live `X-RateLimit-Limit` header divided by the number of concurrent watchers, with a 2000 ms minimum, so parallel waiters slow each other down instead of collectively hitting 429. On a 429 it sleeps exactly `Retry-After` and resumes.

**Deleting a mailbox does not refund daily quota.** The 50/day counter increments on creation and nothing decrements it. That single fact is why the Playwright `inbox` fixture is worker-scoped and reused, and why `freshInbox` is opt-in: a per-test mailbox in a 50-test suite is a whole day of Free quota in one CI run. Mailboxes expire on their own after 24h — delete only when you want the data gone now.

**The third ceiling is per mailbox, and nothing surfaces it.** A mailbox accepts 50 messages on Free, 200 on Starter and 1,000 on Scale. The cap is fixed on the mailbox when it is created, so a plan change does not lift it on mailboxes that already exist, and it counts mail *received* over the mailbox's lifetime — deleting messages does not free capacity. Mail past the cap is **dropped, not rejected**: the sender's server sees a successful delivery, no error is raised, no response header reports it, and nothing in `/v1` distinguishes a full mailbox from a quiet one. The only signal available to you is `messageCount` sitting still. Long-lived mailboxes are where this bites — see the [Playwright](#playwright) fixtures.

`ntm.me()` is metered in *peek* mode, so polling it never consumes the quota it reports on. Live counters are also on the client after any request:

```ts
const ntm = new NowTempMail({
  lowQuotaThreshold: 5,
  onLowQuota: ({ remaining, limit, reset }) => {
    console.warn(`${remaining}/${limit} mailboxes left today, resets ${reset.toISOString()}`);
  },
});

await ntm.mailboxes.create();
ntm.metering.quota;      // { limit, remaining, reset } | null
ntm.metering.rateLimit;  // { limit, remaining, reset } | null
```

`onRequest` and `onResponse` hooks are there for logging. Neither ever sees the `Authorization` header — it is stripped before any callback runs.

## API reference

`create()` does not resolve until one `GET /v1/mailboxes/{address}` has confirmed the mailbox is readable, because the mail receiver drops inbound mail permanently if the mailbox is not yet readable. If confirmation does not land within three attempts the handle resolves anyway with `inbox.confirmed === false` — a working mailbox with a slow read beats a thrown error.

| Method | Endpoint |
|---|---|
| `ntm.me()` | `GET /v1/me` |
| `ntm.domains.list()` | `GET /v1/domains` |
| `ntm.mailboxes.create(params?)` | `POST /v1/mailboxes` (+ a confirming `GET`) |
| `ntm.mailboxes.get(address)` | `GET /v1/mailboxes/{address}` |
| `ntm.mailboxes.attach(address)` | none — local handle, no network call. `confirmed` is `false`, `createdAt` reads as the epoch and `expiresInMs` is `Infinity` until you `refresh()` |
| `ntm.mailboxes.delete(address)` | `DELETE /v1/mailboxes/{address}` |
| `inbox.refresh()` | `GET /v1/mailboxes/{address}` |
| `inbox.delete()` | `DELETE /v1/mailboxes/{address}` |
| `inbox.messages.page({ limit, cursor })` | `GET /v1/mailboxes/{address}/messages` |
| `inbox.messages.list({ limit })` | the same, auto-paginated as an async iterator |
| `inbox.messages.get(id)` | `GET /v1/mailboxes/{address}/messages/{id}` |
| `inbox.messages.delete(id)` | `DELETE /v1/mailboxes/{address}/messages/{id}` |
| `inbox.waitForMessage(filter?)` | polls page 1 of `.../messages` |
| `inbox.waitForCode(filter?)` | polls page 1 of `.../messages`, never fetches a body |
| `attachment.download()` | `GET /v1/.../messages/{id}/attachments/{attachmentId}` |
| `ntm.reservations.list()` | `GET /v1/reservations` |
| `ntm.reservations.release(address)` | `DELETE /v1/reservations/{address}` |
| `ntm.webhooks.test(endpointId?)` | `POST /v1/webhooks/test` |
| `ntm.webhooks.delete(id)` | `DELETE /v1/webhooks/{id}` |

### `create(params?)`

All optional, and `null` is identical to omitting the field.

| Param | Requires | Rules |
|---|---|---|
| `address` | `plan.customAddress` | Local part or full address; everything from the first `@` is discarded. 3–64 chars, `[a-z0-9._-]`, alphanumeric at both ends, no `..`, not a reserved name |
| `domain` | nothing | Must appear in `ntm.domains.list()` |
| `ttlSeconds` | `<= plan.maxTtlSeconds` | Whole number, minimum 300. Rejected, never clamped. Omit for 86400 (24h) on every plan |
| `reserve` | `address` and `plan.reservedAddresses` | A real boolean. The string `"true"` is a 422 |
| `webhookUrl` | `plan.webhooks` | https, port 443 or 8443, public multi-label DNS name, no credentials |

A rejected create still spends a per-minute slot **and** a mailbox from your daily quota — metering runs before validation. Validate locally before you loop.

### `MessageFilter`

Accepted by `waitForMessage` and `waitForCode`.

```ts
await inbox.waitForCode({
  from: /noreply@github\.com/,   // RegExp, or a case-insensitive substring
  subject: "verify your device", // same: substring, case-insensitive
  after: new Date(),             // default: the mailbox's own createdAt
  ignoreExisting: true,          // shorthand for after = now
  match: (m) => m.verificationCodes.length === 1,
  timeoutMs: 60_000,
  pollIntervalMs: 2_000,         // default: derived from the rate limit headers
  signal: AbortSignal.timeout(120_000),
});
```

The high-water mark defaults to the mailbox's `createdAt`, not to when you called — mail can land before anyone is waiting for it, and a fixture that creates the mailbox in `beforeAll` would otherwise miss it. Use `ignoreExisting: true` on resend flows, where a stale code *is* the bug. (The Playwright fixtures handle this for you with a [per-test watermark](#watermarking).)

**A handle from `attach()` is the exception, and it matters.** It never talked to the API, so its `createdAt` reads as the epoch and the default mark accepts every message already in the inbox — including one from an hour ago. Always pass `after` or `ignoreExisting` when you attach.

An explicit `pollIntervalMs` is honoured verbatim: no floor, no jitter. The 2000 ms floor applies only to the derived default. Two watchers on one key at `pollIntervalMs: 200` will earn a 429 and it will be your doing, so leave it unset unless you are pointing at a local instance of the API.

Polling reads page one only and dedupes by message id. It never paginates: messages are newest-first, so new mail lands at the front and a cursor walk can miss it.

`verificationCodes` is a heuristic, not an oracle. It finds 4–8 digit numeric codes and 6–10 character uppercase alphanumeric codes containing at least one digit, within 200 characters of a word like *code*, *otp*, *verify* or *passcode*. It can return several candidates in no meaningful order, and a message can legitimately produce none. Filter by `from` or `subject` when you need certainty, and fall back to `message.text` yourself.

### `Message`

```ts
const message = await inbox.waitForMessage({ subject: "Your invoice" });

message.code;               // first verification code, or null
message.verificationCodes;  // all candidates
message.from;               // raw From header: 'GitHub <noreply@github.com>'
message.fromAddress;        // 'noreply@github.com', or null
message.links();            // URL[] parsed from text and html, deduped, order preserved
message.text;               // falls back to raw HTML source when there was no text/plain part
```

`links()` is the reset-password path: click the link rather than typing a code.

```ts
const [reset] = message.links().filter((u) => u.pathname.startsWith("/reset"));
await page.goto(reset.href);
```

### Attachments

```ts
for (const attachment of message.attachments) {
  const { bytes, contentType, filename } = await attachment.download();
  // filename is SENDER-CONTROLLED. Never join it onto a path you write to.
  await writeFile(join(tmpdir(), `${attachment.id}.bin`), bytes);
}
```

Attachment bytes and filenames come from whoever sent the mail. Treat both as hostile.

## Examples

Runnable files in [`examples/`](https://github.com/nowtempmail/nowtempmail-node/tree/main/examples) in the repository. They are not in the npm tarball — the published package is `dist/` and the docs, nothing else.

| File | Shows |
|---|---|
| `signup-otp.ts` | The whole flow end to end, with error handling |
| `playwright-signup.spec.ts` | The Playwright fixtures in a real spec |
| `webhook-receiver.ts` | Express + `verifyWebhook`, ack-then-work |
| `custom-filter.ts` | `match`, `after`, and paging history with `messages.list()` |
| `attachment-download.ts` | Waiting for mail with an attachment and saving it safely |

## Links

- [API quickstart](https://nowtempmail.com/developers) — the HTTP API without an SDK
- [OpenAPI document](https://nowtempmail.com/v1/openapi.json) — unauthenticated, always current
- [Changelog](./CHANGELOG.md)
- [Security policy](https://github.com/nowtempmail/nowtempmail-node/blob/main/SECURITY.md)
- [Report a bug or request a feature](https://nowtempmail.userjot.com) — the public board, where the roadmap lives too

## Reporting a problem

Bugs, feature requests and questions all go to **[nowtempmail.userjot.com](https://nowtempmail.userjot.com)**, not to GitHub issues. It is the same board the rest of NowTempMail uses, so a report lands next to the roadmap rather than in a tracker nobody watches.

**A security vulnerability is the exception: email [contact@nowtempmail.com](mailto:contact@nowtempmail.com), never the board.** Everything posted there is world-readable the moment it is posted. See [SECURITY.md](https://github.com/nowtempmail/nowtempmail-node/blob/main/SECURITY.md) for scope and what to include.

Two things make an ordinary report actionable, and both are in the error you already have:

- **`err.requestId`** — every error that reached the wire carries one, and it is written to our server log. Quoting it turns "a call failed" into a single log line we can read. Errors the SDK raises itself rather than from an API response — `timeout`, `config_error`, `browser_use_refused`, `webhook_signature` and `webhook_config` — have no request id, so `err.requestId` is `undefined` there; send `err.toLogString()` instead.
- **`err.code`** — the stable machine-readable code, e.g. `plan_upgrade_required`. The `detail` text is prose and may be reworded; the code will not be.

```ts
catch (err) {
  if (NowTempMailError.is(err)) {
    console.error(err.toLogString());
    // plan_upgrade_required status=402 POST /v1/mailboxes requestId=req_8Kd2mQx7Rp4Lv9Nb3 parameter=ttlSeconds
  }
}
```

`toLogString()` is built for exactly this: it contains the code, status, method, path, request id and offending parameter, and it contains no credential material — so it is safe to paste into a public board.

## License

MIT © NowTempMail
