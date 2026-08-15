import { defineConfig } from "tsup";

// Dual ESM+CJS. ESM-only is the better 2026 default, but this package's
// audience includes Jest/CJS test suites, which is the documented exception.
// The dual-package hazard that follows is handled in src/errors.ts with a
// Symbol.for brand rather than bare `instanceof`.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/webhooks/index.ts",
    "src/playwright/index.ts",
    "src/mcp/index.ts",
    "src/cli/bin.ts",
    "src/mcp/bin.ts",
  ],
  format: ["esm", "cjs"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
  dts: true,
  clean: true,
  target: "node20",
  platform: "node",
  // Shared code must be emitted ONCE, not inlined into every entry.
  //
  // With splitting off, each of the six entry points bundled its own private
  // copy of http/client/mailbox/message/errors/types — twelve copies across two
  // formats, which took the published tarball to 840 KB. The client itself is
  // only ~46 KB; the rest was duplication.
  splitting: true,
  sourcemap: false,
  treeshake: true,
  // Peers are optional and must never be bundled — a plain client install has
  // neither on disk.
  external: ["@playwright/test", "@modelcontextprotocol/sdk"],

  // Drop the CJS twins of the two executables.
  //
  // `bin` entries are run by node against the shebang, and package.json points
  // at the .js files; nothing can ever resolve bin.cjs. tsup emits them anyway
  // because format is set per-build, not per-entry. Their chunks are shared with
  // the library CJS output, so removing just these two files is safe and costs
  // roughly 50 KB of published tarball.
  async onSuccess() {
    const { rm } = await import("node:fs/promises");
    for (const dead of ["dist/cli/bin.cjs", "dist/mcp/bin.cjs"]) {
      await rm(dead, { force: true });
    }
  },
});
