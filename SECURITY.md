# Security policy

## Reporting a vulnerability

Email **contact@nowtempmail.com**. Put "security" somewhere in the subject line
so it is routed rather than queued.

Please do **not** use:

- **[nowtempmail.userjot.com](https://nowtempmail.userjot.com)** — that board is
  the public roadmap. Everything posted there is world-readable the moment it is
  posted.
- **GitHub issues** — they are disabled on this repository, and this repository
  is a release mirror in any case (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

Both are the right places for ordinary bugs. Neither is the right place for a
vulnerability.

If you would like to encrypt the report, say so in a first mail with no details
and we will arrange a key.

## What to include

The more of this you have, the faster the fix:

- The version of `nowtempmail` and the Node version it ran on.
- What an attacker gains, concretely — read another key's mail, recover a
  credential, get a forged webhook accepted.
- The smallest reproduction you can manage. A failing test against the mock at
  `test/helpers/mock-api.ts` is ideal; a script is fine.
- **The `requestId` from any error you saw.** Every error the SDK raises after
  reaching the wire carries one, and it maps to a line in our server log — it
  lets us reconstruct exactly what the API did on your behalf. `err.requestId`,
  or the whole of `err.toLogString()`, which contains no credential material.
- Whether you have disclosed this anywhere else, and any deadline you are
  working to.

Please do not include a live API key, a webhook signing secret, or real
customer mail. If a credential is central to the report, say so and we will find
a way to reproduce it without you sending it.

## What to expect

- **Acknowledgement within 3 business days.** NowTempMail is a small operation,
  not a 24/7 response team; the honest commitment is days, not hours.
- **An initial assessment within 10 business days** — whether we can reproduce
  it, whether we agree on severity, and a rough timeline.
- Progress updates as the fix moves, without you having to chase.
- A fix released as a patch version, with the advisory published once users have
  had a reasonable window to upgrade.

We ask for the usual courtesy of not disclosing publicly until a fix has
shipped, and we will tell you if we are going to miss a date rather than go
quiet.

## Credit

We will credit you by name and link in the advisory and the changelog if you
want it, exactly as you would like to be named, and we will happily stay silent
if you would rather. Just say which. There is no bug bounty programme — we
cannot pay, and pretending otherwise would waste your time.

## Scope

This repository is the source for the `nowtempmail` npm package, an API client.
In scope, non-exhaustively:

- **Credential leakage** — an API key or webhook signing secret reaching a log,
  an error message, `toString`, a hook payload, a Playwright trace or report
  attachment, or any request other than the one it authenticates.
- **Signature verification bypass** — anything that makes `verifyWebhook` or
  `isValidWebhookSignature` accept a payload it should reject: a timing leak in
  the comparison, mishandling of the timestamp tolerance, a header-parsing trick,
  or a secret-handling flaw.
- **Injection through mail content.** Inbound email is attacker-controlled text
  and it flows through this package. Anything a hostile sender can achieve —
  path traversal via an attachment filename, escaping the MCP server's
  shape-constrained returns or its untrusted-content fencing, a link or code
  parser that can be steered into a bad value, a redirect that replays the
  bearer token.
- Prototype pollution, ReDoS in the parsers, and TLS or redirect handling that
  weakens transport security.

Out of scope: findings that require an attacker who already has the API key or
the machine; vulnerabilities in `devDependencies` that cannot reach a published
artifact (the package has zero runtime dependencies by design); missing hardening
with no demonstrated impact; and automated scanner output with no analysis
attached.

Vulnerabilities in the **hosted service** — the API at `nowtempmail.com`, the
web app, the developer portal — are equally welcome and go to the same address,
**contact@nowtempmail.com**. Please do not run load or denial-of-service tests
against production, and please use your own account and your own mailboxes.
