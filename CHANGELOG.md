# Changelog

All notable changes to this package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-08-15

Documentation only. No code change, no API change — but the corrections matter,
because several statements in the 0.1.1 README were wrong about the service
rather than merely unclear.

### Fixed

- **The webhook signing secret cannot be read back or rotated.** The README said
  it could be, from the developer portal. It is shown once, on the screen that
  creates the key, and no endpoint or portal screen returns it afterwards. If it
  is lost, the answer is a new key. The rotation guidance, including the advice
  about events rejected during a rotation window, described something that does
  not exist and has been removed.
- **`ntm_test_` keys are not metered against Free today.** While the paywall is
  off, they resolve to the launch plan like every other key. The Free pinning
  takes effect when billing goes live.
- **The plan table described a paywall that is currently switched off.** Every
  account presently receives the launch plan's limits and all four gated
  capabilities — custom addresses, reserved addresses, extended TTL and
  webhooks — so a Free-tier reader was being told features were unavailable that
  work right now. The table is labelled as the post-billing state, and the
  Webhooks section says the same. Read `ntm.me()` rather than inferring a tier.
- **There is a third ceiling, and nothing surfaces it.** A mailbox accepts 50
  messages on Free, 200 on Starter and 1,000 on Scale. Mail past that is dropped
  rather than rejected: no error, no header, nothing in `/v1` that distinguishes
  a full mailbox from a quiet one. Deleting messages does not free capacity — the
  counter is of mail received, not mail held. This is documented in the limits
  section and, because the worker-scoped `inbox` fixture is exactly what
  accumulates, in the Playwright section too.
- Smaller corrections: `requestId` is carried by every error *that reached the
  wire*, not every error; `apiKey` is a normal client option, not one of the
  Playwright fixture-only keys; `forbidden` is reserved and emitted by no
  endpoint; `get_code` accepts `ignoreExisting`; `read_message` truncates
  `From`, `Subject` and body together at 2,000 characters, not the body alone;
  and the plan table now carries exact reserved-address and TTL values.

### Added

- `SECURITY.md` ships in the package. A security policy that reaches only the
  repository is no use to someone who has the tarball and has found something.
  The README now carries the carve-out too: vulnerabilities go to
  `contact@nowtempmail.com`, never the public feedback board.

### Changed

- Links to `examples/` and the contributing and security documents are absolute
  and point at the repository, since only `SECURITY.md` is in the tarball.

## [0.1.1] - 2026-08-15

Documentation fix with the code change that makes the documentation true. No API
change; nothing that worked in 0.1.0 stops working.

### Fixed

- **The MCP invocation in the 0.1.0 README does not exist.** It said to run
  `npx -y nowtempmail-mcp@0.1.0`, which 404s: npx resolves a *package* name, and
  `nowtempmail-mcp` is the name of a second bin inside the `nowtempmail` package
  rather than a package of its own. Every MCP client configured from that README
  failed to start the server. The working spellings are now documented, and one
  of them is new.

### Added

- `nowtempmail mcp` — the MCP stdio server as a subcommand of the main binary,
  so `npx -y nowtempmail@0.1.1 mcp` works. Everything after `mcp` is handed to
  the server untouched, including its own flags: `nowtempmail mcp
  --allow-body-read --max-mailboxes 5`. `nowtempmail mcp --help` and
  `nowtempmail mcp --version` print the server's help and version and exit
  without opening a transport or reading a key.
- `mcp` is listed in `nowtempmail --help`, alongside the commands it is not one
  of. It is intercepted before the CLI's flag parser runs, because the MCP server
  has a different flag vocabulary and routing it through the CLI's strict
  unknown-flag handling would mean loosening that handling for every command.

### Unchanged

- The `nowtempmail-mcp` bin is still published and still behaves identically.
  Existing `.mcp.json` files that invoke it directly keep working; the explicit
  form is `npx -y -p nowtempmail nowtempmail-mcp`, where `-p` is what tells npx
  which package the bin comes from.
- The security guidance around it: pin the version, and keep
  `"env": { "NTM_API_KEY": "${NTM_API_KEY}" }`. `.mcp.json` gets committed, so a
  literal key in one is a published key.

## [0.1.0] - 2026-08-14

First public release. Everything below is new; the list exists so you can see
the surface area, and the boundaries, before you depend on it.

### Added

- `NowTempMail` client covering every `/v1` operation: `me()`, `domains.list()`,
  `mailboxes.create/get/attach/delete`, `reservations.list/release`,
  `webhooks.test/delete`.
- `Mailbox` handle with `messages.page()`, `messages.list()` (async iterator over
  history), `messages.get()`, `messages.delete()`, `refresh()` and `delete()`.
- `waitForCode(filter?)` and `waitForMessage(filter?)`. Verification codes are
  extracted server-side on ingest and ride on the message summary, so
  `waitForCode` never fetches a message body.
- `MessageFilter` with `from`, `subject`, `after`, `ignoreExisting`, `match`,
  `timeoutMs`, `pollIntervalMs` and `signal`. The high-water mark defaults to the
  mailbox's `createdAt` rather than call time, so mail that arrives before anyone
  waits for it is still seen.
- Poll interval derived from the live `X-RateLimit-Limit` header divided by the
  number of concurrent watchers, floor 2000 ms, so parallel waiters throttle each
  other instead of collectively earning a 429. On a 429 the SDK sleeps exactly
  `Retry-After` and resumes.
- `Message` with `code`, `verificationCodes`, `fromAddress` parsed out of the raw
  `From` header, and `links()` returning deduped `URL`s from both text and HTML.
- `Attachment.download()` returning `{ bytes, contentType, filename }`.
- One error class per RFC 9457 problem code, plus local `TimeoutError`,
  `ConnectionError`, `BrowserUseRefusedError`, `MailboxMayExistError`,
  `WebhookSignatureError`, `WebhookConfigError` and `ConfigError`. Every error
  that reached the wire carries `requestId`.
- `NowTempMailError.is()`, a `Symbol.for()` brand check that survives the
  dual-package hazard. Branch on it or on `err.code`, never on `instanceof`.
- `err.toLogString()` for a compact log line that provably contains no
  credential material.
- Metering surfaced as `ntm.metering` (`rateLimit`, `quota`) plus `onRequest`,
  `onResponse` and `onLowQuota` hooks. The `Authorization` header is stripped
  before any hook sees it.
- `nowtempmail/webhooks`: `verifyWebhook()` and `isValidWebhookSignature()`.
  HMAC-SHA256 over `${t}.${rawBody}`, 300s default tolerance, every `v1`
  candidate compared in constant time with no early exit, unknown schemes
  tolerated so a future digest migration is not a breaking change. Built on
  `crypto.subtle`, so it runs on Workers and Deno as well as Node.
- `nowtempmail/webhooks` also re-exports `NowTempMailError`, so a verify-only
  receiver never has to import the client to handle its own errors.
- `nowtempmail/playwright`: `test` and `expect` re-exported with `inbox`
  (worker-scoped, shared, not deleted at teardown), `freshInbox` (per-test,
  opt-in, deleted), `ntm` and the `ntmOptions` option fixture.
- Per-test watermarking, which is what makes a shared `inbox` safe. An auto
  fixture re-stamps a boundary at the start of every test and
  `waitForCode()` / `waitForMessage()` default their `after` to it, so test #7
  cannot resolve with the code test #3 triggered — a failure mode whose symptom
  is a green suite that tests nothing. The mark is floored to the second and set
  back 1s (`ntmOptions.watermarkSkewMs`), because `receivedAt` is second-granular
  and a CI clock is not the API's; without the skew the boundary can land after
  the mail the test caused. Two tests in one file triggering mail from the same
  sender inside the same second can still collide — add `from` or `subject`.
- Trace attachments are redacted to subject, sender, `receivedAt`, codes and
  counts of what was withheld; `ntmOptions.attachBody` opts into bodies and links.
- `@playwright/test` is loaded lazily and guarded, so importing
  `nowtempmail/playwright` without it installed does not throw at import time.
  A fixture that is actually used raises a `ConfigError` naming the missing peer.
  `playwrightAvailable` is exported for diagnostics.
- `nowtempmail` CLI: `new`, `code`, `tail`, `ls`, `rm`, `whoami` and `domains`.
  `new --wait-code` creates a mailbox and waits for its first code in one call,
  printing the address on the first stdout line and the code on the second.
  Payload on stdout, everything else on stderr, so `CODE=$(nowtempmail code …)`
  captures the bare code.
- Documented CLI exit codes: `0` success, `1` API or runtime failure, `2` usage
  (which includes `invalid_request`, because the API rejecting a value means a
  bad flag was typed), `4` a wait that elapsed with no match, `130` ⌃C during
  `code` or `new --wait-code`. `4` and `130` exist so that a shell script can
  tell "no mail arrived" and "the user gave up" apart from "your key is revoked";
  `tail` exits `0` on ⌃C because running until interrupted is its job.
- `nowtempmail-mcp` MCP server exposing `create_mailbox`, `list_messages`,
  `get_code` and `delete_mailbox`, plus `read_message` only under
  `--allow-body-read`. No bodies, no HTML and no links in the default surface,
  and a per-process cap on mailbox creation (`--max-mailboxes`, default 10).
- ESM and CJS builds with generated type declarations for every entry point.
- Per-condition `types` in the `exports` map: `require` resolves to `.d.cts` and
  `import` to `.d.ts`. Without the split, a CJS consumer on
  `moduleResolution: "node16"` gets the ESM declarations under `require` and sees
  phantom errors about a module that works fine at runtime.
- Code splitting, so the five entry points share one copy of the core instead of
  each inlining it. `import { NowTempMail } from "nowtempmail"` pulls 46.7 KB of
  ESM — the number `npm run size` budgets, because it is what a serverless cold
  start actually pays for — out of a 399.5 KB, 38-file tarball that also carries
  both binaries, the CJS twins and every declaration file.
- Pruned the CJS builds of both binaries. `bin` entries are executed, never
  `require`d, so a second copy of each was dead weight in the tarball.

### Security

- Zero runtime dependencies. Global `fetch` and `crypto.subtle` only.
- `redirect: "error"` on every API request, so the bearer token can never be
  replayed to a `Location` we did not choose.
- The API key is never logged, embedded in an error, serialised by `toString`, or
  exposed to a hook payload.
- Construction throws `BrowserUseRefusedError` in a real browser. `/v1` emits no
  CORS headers and rejects any request carrying an `Origin` header with `403`
  before it reads the key, so a key shipped to a browser is both public and
  useless. The detection is narrow (`document` present, `process.versions.node`
  absent) so jsdom test environments are unaffected.
- `POST /v1/mailboxes` is never retried. It is the only quota-consuming endpoint
  and the API has no idempotency key, so a transport failure raises
  `MailboxMayExistError` instead of silently spending a second mailbox.
- `verifyWebhook` refuses a missing or blank secret with `WebhookConfigError`
  before computing anything — an HMAC keyed on `undefined` is a verifier that
  accepts forgeries, and no test written against a real signature would notice.
- MCP tool returns are shape-constrained because inbound email is
  attacker-controlled text that lands directly in a model's context.
  `read_message` is gated behind `--allow-body-read` and returns HTML stripped to
  text, truncated, inside an explicit untrusted-content delimiter.

### Known limitations

- Node >= 20. Node 18 is not tested and not supported.
- `mailboxes.create()` resolves with `confirmed: false` rather than throwing when
  the post-create readability check does not land within three attempts.
- No wrapper for `GET /v1/.../attachments`; attachment metadata already arrives
  on the message, so the list endpoint would return nothing new.
- Deleting a mailbox does not refund daily quota. Nothing in this package can
  change that, which is why the Playwright `inbox` fixture is shared by default.
- `@playwright/test` and `@modelcontextprotocol/sdk` are optional peers. Both
  subpaths import cleanly without them and fail with an explanatory `ConfigError`
  only when something is actually used — but that failure is at first use, which
  in Playwright's case means mid-test rather than at collection.
- A handle from `mailboxes.attach()` reports `createdAt` as the epoch, since it
  has not talked to the API. The default `waitFor*` boundary therefore accepts
  every message already in the mailbox; pass `after` or `ignoreExisting`
  explicitly, or call `refresh()` first.
- The Playwright watermark has one-second resolution, so two tests in the same
  file that trigger mail from the same sender within the same second can still
  match each other's. Disambiguate with `from` or `subject`.

[Unreleased]: https://github.com/nowtempmail/nowtempmail-node/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/nowtempmail/nowtempmail-node/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/nowtempmail/nowtempmail-node/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/nowtempmail/nowtempmail-node/releases/tag/v0.1.0
