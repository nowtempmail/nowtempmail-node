#!/usr/bin/env node
/**
 * Spec drift check.
 *
 *   node scripts/check-spec-drift.mjs
 *   node scripts/check-spec-drift.mjs --offline     # skip the fetch, exit 0
 *   NTM_OPENAPI_URL=http://localhost:8787/v1/openapi.json node scripts/check-spec-drift.mjs
 *
 * Fetches the live OpenAPI document from https://nowtempmail.com/v1/openapi.json
 * and compares its operation set — every (method, path) pair under `paths` —
 * against the document vendored at spec/openapi.json, which is what this SDK was
 * written from. Refresh that snapshot with `npm run spec:vendor`.
 *
 * Exit 1 means the API grew or lost an operation and this package's types,
 * client methods and README are now describing something that no longer exists.
 * Exit 0 means they agree, or that we could not reach the network and said so.
 *
 * ## One parser, both sides
 *
 * Both documents go through `readOperations()`. That is deliberate and it is the
 * main reason the vendored copy is JSON rather than the YAML source: comparing a
 * YAML line-reader against a JSON parser means every asymmetry between the two
 * readers manufactures phantom drift, and a tripwire that cries wolf gets
 * deleted. With one parser on both sides, a reported difference is a real
 * difference in the documents — never a difference in how they were read.
 *
 * One deliberate limitation: operations only. Schemas, parameters and response
 * codes are not compared; that needs a real OpenAPI differ and this is a
 * tripwire, not a linter. Reviewing `git diff spec/openapi.json` after a
 * re-vendor is what catches the rest.
 *
 * It also runs on developer laptops, and a laptop on a train must not fail a
 * build. Anything that is not a confirmed difference exits 0 with a warning.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDORED = join(ROOT, "spec", "openapi.json");
const LIVE_URL = process.env.NTM_OPENAPI_URL ?? "https://nowtempmail.com/v1/openapi.json";
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
/* The one parser                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reads the operation set out of a parsed OpenAPI document.
 *
 * Returns a Map of path -> Set<method>, or null when the value handed in is not
 * an OpenAPI document at all.
 *
 * The top-level `webhooks` mapping is intentionally excluded: those are requests
 * the API makes to you, not routes you call, and they do not live under `paths`.
 */
function readOperations(document) {
  const operations = new Map();
  const paths = document?.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return null;

  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    const methods = new Set(
      Object.keys(item).filter((key) => HTTP_METHODS.has(key.toLowerCase())),
    );
    operations.set(path, methods);
  }

  return operations;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Flatten to a sorted list of "GET /v1/me" strings, which diff cleanly. */
function flatten(operations) {
  const flat = [];
  for (const [path, methods] of operations) {
    for (const method of methods) flat.push(`${method.toUpperCase()} ${path}`);
  }
  return flat.sort((a, b) => a.localeCompare(b));
}

/**
 * "We could not check." Prints, and always yields 0 — callers write
 * `return skip(reason)`. Never used for a difference we actually observed.
 */
function skip(reason, detail) {
  console.warn(`\nspec drift check skipped: ${reason}`);
  if (detail) console.warn(`  ${detail}`);
  console.warn(
    "  Operations were not compared. This is not a pass — it is a check that\n" +
      "  did not run. CI is where it is expected to actually run.\n",
  );
  return 0;
}

/** Drain a response we are not going to read, so the socket closes cleanly. */
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed. Nothing to do, and nothing worth reporting.
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
 * and an exit code of 127, which would read as a CI failure on a check that had
 * in fact decided to pass.
 */
async function main() {
  let vendoredDocument;
  try {
    vendoredDocument = JSON.parse(readFileSync(VENDORED, "utf8"));
  } catch (err) {
    // A missing or corrupt vendored spec is a real problem: this script is the
    // only thing watching the contract, and it cannot watch nothing.
    console.error(`\nspec drift check failed: could not read ${VENDORED}`);
    console.error(`  ${err.name}: ${err.message}`);
    console.error("  Run `npm run spec:vendor` to fetch it.\n");
    return 1;
  }

  const vendored = readOperations(vendoredDocument);
  if (!vendored) {
    console.error(`\nspec drift check failed: ${VENDORED} has no \`paths\` object.`);
    console.error("  That is not an OpenAPI document. Re-run `npm run spec:vendor`.\n");
    return 1;
  }

  const vendoredFlat = flatten(vendored);
  if (vendoredFlat.length === 0) {
    // Valid JSON with an empty (or method-less) `paths` parses fine and yields
    // nothing to compare, so the check would pass against every possible live
    // document. That is a failure, not a pass.
    console.error(`\nspec drift check failed: found 0 operations in ${VENDORED}.`);
    console.error(
      "  The document parsed, but it describes no routes, so there is nothing to\n" +
        "  compare the live API against and this check would pass unconditionally.\n" +
        "  Re-run `npm run spec:vendor` rather than deleting the check.\n",
    );
    return 1;
  }

  if (process.argv.includes("--offline")) {
    return skip(
      "--offline was passed",
      `${vendoredFlat.length} vendored operations were left unchecked.`,
    );
  }

  // An explicit controller with a cleared timer, rather than
  // AbortSignal.timeout(), so no handle outlives the request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(LIVE_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (err) {
    // DNS, TLS, offline, proxy, timeout. All the same from here: unreachable.
    return skip(`${LIVE_URL} is unreachable`, `${err.name}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Even a 404 is treated as unreachable rather than as drift. Exit 1 has to
    // mean "the operation sets differ", or nobody will trust it.
    await discard(response);
    return skip(`${LIVE_URL} returned HTTP ${response.status}`, "Retry, or check the deployment.");
  }

  let liveDocument;
  try {
    liveDocument = await response.json();
  } catch (err) {
    return skip(`${LIVE_URL} did not return JSON`, `${err.name}: ${err.message}`);
  }

  const live = readOperations(liveDocument);
  if (!live) {
    return skip(
      `${LIVE_URL} returned JSON with no \`paths\` object`,
      "That is not an OpenAPI document.",
    );
  }

  const liveFlat = flatten(live);
  if (liveFlat.length === 0) {
    return skip(
      `${LIVE_URL} reported 0 operations`,
      "Treating an empty spec as a bad read, not as drift.",
    );
  }

  const vendoredSet = new Set(vendoredFlat);
  const liveSet = new Set(liveFlat);
  const added = liveFlat.filter((op) => !vendoredSet.has(op)); // live has it, we do not
  const removed = vendoredFlat.filter((op) => !liveSet.has(op)); // we have it, live does not

  console.log(`\nspec drift: ${LIVE_URL}`);
  console.log(`            vs ${VENDORED}\n`);
  console.log(`  live      ${liveFlat.length} operations across ${live.size} paths`);
  console.log(`  vendored  ${vendoredFlat.length} operations across ${vendored.size} paths`);

  if (added.length === 0 && removed.length === 0) {
    console.log(`\nno drift: both documents describe the same ${liveFlat.length} operations.\n`);
    return 0;
  }

  if (added.length > 0) {
    console.error("\n  added upstream — live /v1 has these, the vendored spec does not:");
    for (const op of added) console.error(`    + ${op}`);
  }
  if (removed.length > 0) {
    console.error("\n  gone upstream — the vendored spec has these, live /v1 does not:");
    for (const op of removed) console.error(`    - ${op}`);
  }

  console.error(
    "\nspec drift check failed.\n\n" +
      "  `added` means there is API surface this SDK does not wrap yet.\n" +
      "  `gone` is the dangerous one: a documented client method now calls an\n" +
      "  endpoint that no longer exists, and the failure will land on a user.\n\n" +
      "  Re-vendor with `npm run spec:vendor`, then reconcile src/ and README.md\n" +
      "  before releasing.\n",
  );
  return 1;
}

process.exitCode = await main();
