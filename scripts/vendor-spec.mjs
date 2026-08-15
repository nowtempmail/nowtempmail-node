#!/usr/bin/env node
/**
 * Re-vendor the OpenAPI document.
 *
 *   node scripts/vendor-spec.mjs
 *   NTM_OPENAPI_URL=http://localhost:8787/v1/openapi.json node scripts/vendor-spec.mjs
 *
 * Fetches the compiled OpenAPI document that /v1 already serves publicly and
 * unauthenticated, and writes it to spec/openapi.json. That file is the
 * reference point `check-spec-drift.mjs` compares against — the snapshot of the
 * API this SDK was written from.
 *
 * ## Why fetch rather than copy
 *
 * The document is fetched from the live URL rather than copied out of the
 * service repo. "This content is already public" is then true by construction
 * rather than by review: whatever lands here is byte-for-byte what any
 * anonymous caller can already GET. Nothing internal can arrive by accident,
 * because nothing internal is on the other end of that URL.
 *
 * For the same reason the response is written through unmodified apart from
 * formatting. Hand-editing the vendored document would make drift detection
 * meaningless — the check would then be comparing live /v1 against somebody's
 * opinion of it.
 *
 * Node builtins only. This is a maintainer script in a package with zero
 * runtime dependencies, and it is not the place to acquire one.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDORED = join(ROOT, "spec", "openapi.json");
const SOURCE_URL = process.env.NTM_OPENAPI_URL ?? "https://nowtempmail.com/v1/openapi.json";
const TIMEOUT_MS = 15_000;

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

/* -------------------------------------------------------------------------- */
/* Shape checks                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Is this actually an OpenAPI document with routes in it?
 *
 * This gate is the whole reason the script is more than three lines. The
 * vendored file is the only reference point drift detection has; if a bad
 * deploy, a captive portal, a proxy or a CDN error page were allowed to
 * overwrite it, the check would go on passing forever against garbage and
 * nobody would hear anything again. So: refuse to write unless the response
 * parsed as JSON, announces itself as OpenAPI, and carries a non-empty `paths`.
 *
 * Returns null when the document is acceptable, or a reason string when it
 * is not.
 */
function rejectionReason(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return "the response is not a JSON object";
  }
  if (typeof document.openapi !== "string" || document.openapi === "") {
    return "the response has no `openapi` version key, so it is not an OpenAPI document";
  }
  const paths = document.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return "the response has no `paths` object";
  }
  if (Object.keys(paths).length === 0) {
    return "the response has an empty `paths` object, so it describes no routes";
  }
  return null;
}

/** Every (method, path) pair under `paths`. The unit drift is measured in. */
function countOperations(document) {
  let operations = 0;
  let paths = 0;

  for (const item of Object.values(document?.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    paths += 1;
    for (const key of Object.keys(item)) {
      if (HTTP_METHODS.has(key.toLowerCase())) operations += 1;
    }
  }

  return { operations, paths };
}

/** What is on disk right now, so the delta can be printed. Absent is fine. */
function readCurrent() {
  try {
    return JSON.parse(readFileSync(VENDORED, "utf8"));
  } catch {
    // Missing, or unparseable because a previous run was interrupted. Either
    // way there is no meaningful "before" to report, and that is not an error:
    // re-vendoring is exactly how you recover from it.
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Returns the intended exit code rather than calling process.exit().
 *
 * process.exit() while a fetch body or a timer is still live tears the event
 * loop down mid-flight; on Windows that surfaces as a libuv assertion failure
 * and an exit code of 127, which would read as a failure on a run that had in
 * fact succeeded.
 */
async function main() {
  console.log(`\nvendoring ${SOURCE_URL}`);
  console.log(`        -> ${VENDORED}\n`);

  // An explicit controller with a cleared timer, rather than
  // AbortSignal.timeout(), so no handle outlives the request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(SOURCE_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (err) {
    // DNS, TLS, offline, proxy, timeout. All the same from here: unreachable.
    console.error(`vendor failed: ${SOURCE_URL} is unreachable`);
    console.error(`  ${err.name}: ${err.message}`);
    console.error("  Nothing was written. The existing spec/openapi.json is untouched.\n");
    return 1;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Already closed. Nothing to do, and nothing worth reporting.
    }
    console.error(`vendor failed: ${SOURCE_URL} returned HTTP ${response.status}`);
    console.error("  Nothing was written. Retry, or check the deployment.\n");
    return 1;
  }

  let document;
  try {
    document = await response.json();
  } catch (err) {
    // An HTML error page from a proxy or a CDN lands here.
    console.error(`vendor failed: ${SOURCE_URL} did not return JSON`);
    console.error(`  ${err.name}: ${err.message}`);
    console.error("  Nothing was written. The existing spec/openapi.json is untouched.\n");
    return 1;
  }

  const rejection = rejectionReason(document);
  if (rejection) {
    console.error(`vendor refused to write: ${rejection}.`);
    console.error(
      "  Overwriting the vendored spec with this would destroy the only reference\n" +
        "  point drift detection has, and the check would pass quietly forever.\n" +
        "  Nothing was written.\n",
    );
    return 1;
  }

  const before = readCurrent();
  const beforeCounts = before ? countOperations(before) : null;
  const afterCounts = countOperations(document);

  // Pretty-printed, two spaces, trailing newline — and that is load-bearing.
  //
  // The server sends this minified, on a single line. Vendoring it that way
  // would make every future re-vendor diff as "the whole file changed", which
  // destroys the reviewability that is the entire reason to vendor it: a human
  // has to be able to see in a pull request that one operation appeared and
  // nothing else moved. Two-space JSON.stringify is also stable ordering, so
  // re-running with no upstream change produces no diff at all.
  mkdirSync(dirname(VENDORED), { recursive: true });
  writeFileSync(VENDORED, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const version =
    typeof document.info?.version === "string" ? document.info.version : "(no info.version)";

  if (beforeCounts) {
    console.log(
      `  before  ${beforeCounts.operations} operations across ${beforeCounts.paths} paths`,
    );
  } else {
    console.log("  before  (no vendored spec on disk)");
  }
  console.log(`  after   ${afterCounts.operations} operations across ${afterCounts.paths} paths`);

  const delta = afterCounts.operations - (beforeCounts?.operations ?? 0);
  if (beforeCounts && delta === 0) {
    console.log("\n  operation count unchanged. Review the diff for schema and copy changes.");
  } else if (beforeCounts) {
    console.log(`\n  operation count changed by ${delta > 0 ? "+" : ""}${delta}.`);
  }

  console.log(
    `\nvendored OpenAPI ${document.openapi}, API version ${version}.\n\n` +
      "  Review `git diff spec/openapi.json` before committing, then reconcile\n" +
      "  src/ and README.md with anything that moved.\n",
  );
  return 0;
}

process.exitCode = await main();
