# Contributing

Thank you for reading this before opening a pull request — it will save you an
evening.

## This repository is a release mirror

The canonical source for `nowtempmail` lives upstream, in a private workspace
alongside the API it talks to. **This repository receives one squashed snapshot
commit per release.** Nothing is developed here.

The practical consequence, stated plainly: **a pull request merged into this
repository will be silently reverted by the next release sync.** Not rejected,
not argued with — overwritten, because the next snapshot is a wholesale
replacement of the tree. Please do not spend your time on a patch here; it
cannot survive.

The arrangement is not secrecy for its own sake. `npm publish --provenance`
signs an attestation binding the published tarball to a specific workflow run,
commit and repository, and npm refuses provenance from a private repository —
there would be nothing public for anyone to verify the attestation against. So
the source that produces the release has to be public and has to be the thing
that publishes. Mirroring the package out is how you get a verifiable supply
chain for a package built inside a closed workspace.

Everything that would normally be a pull request is genuinely welcome in the
one place it can be acted on:

**[nowtempmail.userjot.com](https://nowtempmail.userjot.com)** — bug reports,
feature requests, and the public roadmap. A report there lands next to the
roadmap and in front of the people who can change the upstream source. GitHub
issues on this repository are disabled for the same reason the PRs cannot land.

Two things make a bug report actionable, and both come free with any error the
SDK throws:

- **`err.requestId`** — every error carries one and it is written to our server
  log. It turns "a call failed" into a single log line we can read.
- **`err.code`** — the stable machine-readable code. The `detail` prose may be
  reworded between releases; the code will not be.

`err.toLogString()` prints both, plus the method, path and offending parameter,
and contains no credential material — it is safe to paste onto a public board.

Security vulnerabilities do **not** go to the public board. See
[SECURITY.md](./SECURITY.md).

Reading the code, forking it, and vendoring it are all fine — the package is
MIT. The mirror policy is about where changes are *authored*, not about what you
may do with the source.

## Invariants — do not break these without a major version

If you are working on a fork, or reading to understand why the code is shaped
the way it is, these six rules are load-bearing. Each one exists because
breaking it produces a failure that is invisible until it is expensive.

1. **Zero runtime dependencies.** Global `fetch`, `crypto.subtle`, and `node:*`
   only where it is unavoidable (the CLI). Never add a `dependencies` entry.
   *Why:* this package ends up in CI pipelines holding live credentials, and
   every transitive dependency is another postinstall script with access to
   them.

2. **Never log or embed the API key.** Not in error messages, not in
   `toString`, not in hook payloads; `Authorization` is stripped before any
   user callback sees headers.
   *Why:* an error object gets serialised into CI logs and pasted into public
   issues, and a key that reaches either of those is a published key.

3. **`redirect: "error"` on every API request.**
   *Why:* following a redirect replays the bearer token to a `Location` we did
   not choose, which hands the credential to whoever controls that response.

4. **Never auto-retry `POST /v1/mailboxes`.** A transport failure there surfaces
   as `MailboxMayExistError`; retries apply to GET and DELETE only.
   *Why:* it is the only quota-consuming endpoint and the API has no idempotency
   key, so a blind retry silently burns two mailboxes for one logical call.

5. **Branch on `err.code`, or `NowTempMailError.is()` — never a bare
   `instanceof`.**
   *Why:* the package is dual-published as ESM and CJS, so a consumer can load
   two copies of the error classes at once. `instanceof` then returns `false`,
   the error branch is skipped, and nothing looks wrong. `is()` checks a
   `Symbol.for()` brand, which is registry-global and agrees across both copies.

6. **Errors always carry `requestId`.**
   *Why:* it is the only value that joins a failure in your terminal to a line
   in our server log, and it is the first thing support asks for.

## Testing

```bash
npm run test        # vitest run
```

Tests live in `test/**/*.test.ts` and **make no network calls** — ever. Use a
stub `fetch`, or the shared mock server at `test/helpers/mock-api.ts`, which
everything may import. A test that reaches the real API is flaky by
construction, spends quota, and needs a credential CI does not have.

Every documented `Problem` code should have a test proving it maps to the right
error class and carries a `requestId`.

The full pre-publish gate is `npm run verify` — typecheck, test, build,
`publint` + `attw`, and the bundle size budget.
