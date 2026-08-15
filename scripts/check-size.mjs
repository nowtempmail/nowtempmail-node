#!/usr/bin/env node
/**
 * Package size budgets.
 *
 *   node scripts/check-size.mjs
 *
 * Asks npm exactly what it would publish (`npm pack --dry-run --json`) and holds
 * the answer against three ceilings:
 *
 *   client entry (ESM)    60 KB   <- the one that matters
 *   total unpacked       480 KB
 *   entry count           40 files
 *
 * ## Why the client entry is the headline number
 *
 * Nobody bundles the whole tarball. A consumer writes `import { NowTempMail }
 * from "nowtempmail"` in a Lambda, a Cloudflare Worker or a Vercel function, and
 * what lands in their artifact is `dist/index.js` plus the chunks it actually
 * reaches — currently ~47 KB. That is the number a cold start pays for, so that
 * is the number with the tight budget. The CLI, the MCP server, the Playwright
 * fixtures, the CJS twins and every `.d.ts` are all in the tarball and none of
 * them are in that graph.
 *
 * The chunk filenames carry a content hash and change on every meaningful build,
 * so they are discovered by parsing the import specifiers out of `dist/index.js`
 * and following them transitively — never hardcoded.
 *
 * ## Why the total is nearly nine times larger
 *
 * Five entry points (`.`, `./webhooks`, `./playwright`, `./mcp`, and the shared
 * chunks) times two module formats, plus two binaries, plus `.d.ts` and `.d.cts`
 * for each. Code splitting means the entry points share one copy of the core
 * rather than each inlining it, which is why the total is as low as it is.
 *
 * For scale, the two commercial alternatives:
 *
 *   mailslurp-client   10.4 MB   2,172 files
 *   mailosaur           245 KB     221 files
 *   nowtempmail         440 KB      42 files
 *
 * 24x smaller than the former. 1.8x the latter's bytes with 5.2x fewer files —
 * while also shipping a CLI, an MCP server, a Playwright fixture and a webhook
 * verifier, none of which either of those has.
 *
 * Node builtins only, on purpose: this runs in CI before anything is installed
 * beyond the lockfile, and it must not be the reason a release is blocked.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** What a serverless consumer bundles for `import { NowTempMail } from "nowtempmail"`. */
const MAX_CLIENT_ENTRY_BYTES = 60 * 1024;
/** Everything npm publishes, unpacked. */
// Raised from 420 KB, which the package reached 98% of the moment the README was
// finished. A tripwire with 7 KB of slack fires on the next docs commit and
// teaches everyone to raise it reflexively, which is how a budget stops meaning
// anything. The number that actually guards against bloat is
// MAX_CLIENT_ENTRY_BYTES above — the bytes a cold serverless import pays for.
// This one only has to catch a genuine balloon, so give it real headroom.
const MAX_UNPACKED_BYTES = 480 * 1024;
// Raised from 40 in 0.1.1, which sat exactly on the ceiling. `nowtempmail mcp`
// loads the MCP server through a dynamic import — deliberately, so an ordinary
// `nowtempmail new` does not pay for a module it will never call — and code
// splitting emits that boundary as one small file per format (~0.7 KB the pair).
// Two files, both accounted for. Kept at an exact fit, as 40 was: unlike the
// byte budgets, this number does not move when someone edits the README — it
// moves only when the build's shape does, and that should always be a decision
// rather than a surprise.
// 43 as of 0.1.2: SECURITY.md now ships. A security policy that reaches only
// the repository is no use to someone who has the tarball and has found
// something — and the npm page is where a reporter looks first. One file, ~3 KB,
// and the exact-fit discipline above is what forced this to be an explicit
// decision rather than a silent drift.
const MAX_ENTRY_COUNT = 43;

/** Where the client entry graph starts. Its chunk imports are discovered, not listed. */
const CLIENT_ENTRY = "dist/index.js";

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function count(n) {
  return String(n);
}

function pct(value, limit) {
  return `${((value / limit) * 100).toFixed(0)}%`;
}

/** A fixed-width usage bar, so "nearly full" is visible at a glance. */
function bar(value, limit, width = 32) {
  const filled = Math.min(width, Math.round((value / limit) * width));
  const over = value > limit;
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]${over ? " OVER" : ""}`;
}

function line(label, value, limit, format) {
  const status = value > limit ? "FAIL" : "ok";
  return (
    `  ${label.padEnd(14)} ${format(value).padStart(10)} / ${format(limit).padStart(10)} ` +
    `${pct(value, limit).padStart(5)}  ${bar(value, limit)}  ${status}`
  );
}

function fail(message, hint) {
  console.error(`\nsize check failed: ${message}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Ask npm                                                                    */
/* -------------------------------------------------------------------------- */

async function runNpmPack() {
  const { spawnSync } = await import("node:child_process");
  // One command string with `shell: true`, rather than an argv array.
  //
  // The shell is not optional: on Windows `npm` is a `.cmd` shim, and Node
  // >= 18.20 refuses to spawn one directly. Given a shell is involved either
  // way, passing an args array as well earns a DEP0190 warning on Node 24 —
  // Node concatenates them without escaping and says so. Every token here is a
  // literal with no interpolation, so there is nothing to escape.
  const result = spawnSync("npm pack --dry-run --json", {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    fail(
      `could not run npm pack (${result.error.code ?? result.error.message})`,
      "Is npm on PATH? This script shells out to npm rather than reimplementing\n" +
        "the ignore rules, because npm's answer is the only one that counts.",
    );
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    fail(
      `npm pack exited ${result.status}`,
      stderr
        ? `npm said:\n${stderr.split("\n").slice(-20).join("\n")}`
        : "npm produced no output on stderr.",
    );
  }

  return result.stdout ?? "";
}

/** npm may prefix notices onto stdout. Take the JSON array and nothing else. */
function parsePackOutput(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) {
    fail(
      "npm pack --json produced no JSON array",
      `stdout was:\n${stdout.trim().slice(0, 500) || "(empty)"}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch (err) {
    fail(`could not parse npm pack --json output (${err.message})`);
  }

  const manifest = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!manifest || typeof manifest !== "object") {
    fail("npm pack --json returned an empty result");
  }
  if (typeof manifest.unpackedSize !== "number" || typeof manifest.entryCount !== "number") {
    fail(
      "npm pack --json did not report unpackedSize / entryCount",
      "That means the npm version in use changed the --json shape. Fix this\n" +
        "script rather than removing it from `npm run verify`.",
    );
  }
  return manifest;
}

/* -------------------------------------------------------------------------- */
/* The client entry graph                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Relative specifiers in an emitted ESM bundle.
 *
 * tsup/esbuild output is machine-generated and boring: static `from "./x.js"`,
 * bare side-effect `import "./x.js"`, and occasionally `import("./x.js")`. Bare
 * package specifiers are skipped — a peer or a `node:` builtin is not our bytes.
 * This is a budget tripwire, not a module resolver, and it does not need to
 * handle every legal form of ESM.
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function readSpecifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("../")) found.add(specifier);
    }
  }
  return found;
}

/**
 * Walk the graph from `entry`, following relative imports transitively.
 *
 * Returns the reachable files in discovery order, so the printed breakdown reads
 * as "the entry, then what it pulled in". Sizes come from npm's own file list
 * when it has them, because those are the bytes that get published.
 */
function walkClientEntry(entry, sizeByPath) {
  const files = [];
  const seen = new Set();
  const queue = [entry];
  const missing = [];

  while (queue.length > 0) {
    const relPath = queue.shift();
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const absolute = join(ROOT, relPath);
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      missing.push(relPath);
      continue;
    }

    const size = sizeByPath.get(relPath) ?? statSync(absolute).size;
    files.push({ path: relPath, size });

    for (const specifier of readSpecifiers(source)) {
      // Resolve against the importing file's directory: a subpath entry point
      // reaches the shared chunks as `../chunk-x.js`, not `./chunk-x.js`.
      const resolved = resolve(dirname(absolute), specifier);
      const next = relative(ROOT, resolved).split(sep).join(posix.sep);
      if (!seen.has(next)) queue.push(next);
    }
  }

  return { files, missing };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const manifest = parsePackOutput(await runNpmPack());
const packFiles = Array.isArray(manifest.files) ? manifest.files : [];
const sizeByPath = new Map(
  packFiles
    .filter((f) => typeof f.path === "string" && typeof f.size === "number")
    .map((f) => [f.path, f.size]),
);
const distFiles = packFiles.filter((f) => typeof f.path === "string" && f.path.startsWith("dist/"));

// The most likely reason this script is run on a machine where it fails is that
// nobody built first. Say so in words rather than reporting "0.4 KB, ok" on a
// tarball with no code in it.
if (distFiles.length === 0) {
  fail(
    "the tarball contains no dist/ files, so this measured nothing.",
    "Run `npm run build` first. `package.json` publishes dist/, README.md,\n" +
      "LICENSE and CHANGELOG.md — without a build there is no package to size.",
  );
}

const { files: entryFiles, missing } = walkClientEntry(CLIENT_ENTRY, sizeByPath);

if (entryFiles.length === 0) {
  fail(
    `could not read ${CLIENT_ENTRY}, so the client entry budget measured nothing.`,
    "Run `npm run build` first. If the build moved the client entry, update\n" +
      "CLIENT_ENTRY in this script — do not delete the budget.",
  );
}
if (missing.length > 0) {
  // A dangling relative import means the graph is incomplete and the number
  // under budget is a number we made up.
  fail(
    `${CLIENT_ENTRY} reaches ${missing.length} file(s) that do not exist: ${missing.join(", ")}`,
    "That is a broken build, not a size problem. The client entry total below\n" +
      "would be an undercount, so this check refuses to report it.",
  );
}

const clientEntryBytes = entryFiles.reduce((sum, f) => sum + f.size, 0);

console.log(`\n${manifest.name ?? "package"}@${manifest.version ?? "?"} — publish budget`);

console.log(`\nclient entry — what a consumer bundles for \`import "nowtempmail"\``);
const entryWidth = Math.max(...entryFiles.map((f) => f.path.length));
for (const file of entryFiles) {
  console.log(`    ${file.path.padEnd(entryWidth)}  ${kb(file.size).padStart(9)}`);
}
console.log(`    ${"".padEnd(entryWidth, " ")}  ${"---------".padStart(9)}`);
console.log(line("client entry", clientEntryBytes, MAX_CLIENT_ENTRY_BYTES, kb));

console.log("\nwhole tarball — every entry point, both formats, both binaries, all types");
console.log(line("unpacked", manifest.unpackedSize, MAX_UNPACKED_BYTES, kb));
console.log(line("files", manifest.entryCount, MAX_ENTRY_COUNT, count));
if (typeof manifest.size === "number") {
  console.log(`\n  tarball        ${kb(manifest.size).padStart(10)}  (gzipped, not budgeted)`);
}

const largest = [...packFiles]
  .filter((f) => typeof f.size === "number")
  .sort((a, b) => b.size - a.size)
  .slice(0, 10);

if (largest.length > 0) {
  console.log("\n  largest entries");
  const width = Math.max(...largest.map((f) => f.path.length));
  const inEntryGraph = new Set(entryFiles.map((f) => f.path));
  for (const file of largest) {
    const share = pct(file.size, manifest.unpackedSize).padStart(5);
    const mark = inEntryGraph.has(file.path) ? " <- client entry" : "";
    console.log(`    ${file.path.padEnd(width)}  ${kb(file.size).padStart(9)}  ${share}${mark}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Verdict                                                                    */
/* -------------------------------------------------------------------------- */

const problems = [];
if (clientEntryBytes > MAX_CLIENT_ENTRY_BYTES) {
  problems.push(
    `client entry is ${kb(clientEntryBytes)}, over the ${kb(MAX_CLIENT_ENTRY_BYTES)} budget by ` +
      `${kb(clientEntryBytes - MAX_CLIENT_ENTRY_BYTES)}. This is the number a cold ` +
      `start pays for — check what new import pulled a chunk into the client graph.`,
  );
}
if (manifest.unpackedSize > MAX_UNPACKED_BYTES) {
  problems.push(
    `unpacked size is ${kb(manifest.unpackedSize)}, over the ${kb(MAX_UNPACKED_BYTES)} budget ` +
      `by ${kb(manifest.unpackedSize - MAX_UNPACKED_BYTES)}`,
  );
}
if (manifest.entryCount > MAX_ENTRY_COUNT) {
  problems.push(
    `${manifest.entryCount} entries, over the ${MAX_ENTRY_COUNT} file budget by ` +
      `${manifest.entryCount - MAX_ENTRY_COUNT}`,
  );
}

if (problems.length > 0) {
  console.error("\nsize check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nEither shrink the build or raise the ceiling in scripts/check-size.mjs —\n" +
      "in this commit, with the reason in the commit message.",
  );
  process.exit(1);
}

console.log(
  `\nsize check passed.\n` +
    `  client entry  ${kb(clientEntryBytes)} of ${kb(MAX_CLIENT_ENTRY_BYTES)} ` +
    `(${kb(MAX_CLIENT_ENTRY_BYTES - clientEntryBytes)} spare)\n` +
    `  unpacked      ${kb(manifest.unpackedSize)} of ${kb(MAX_UNPACKED_BYTES)} ` +
    `(${kb(MAX_UNPACKED_BYTES - manifest.unpackedSize)} spare)\n` +
    `  files         ${manifest.entryCount} of ${MAX_ENTRY_COUNT} ` +
    `(${MAX_ENTRY_COUNT - manifest.entryCount} spare)\n`,
);
