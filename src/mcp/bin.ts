#!/usr/bin/env node
/**
 * `nowtempmail-mcp` — the direct stdio entry point for the MCP server.
 *
 * Process wiring only. The argv parsing, the usage text and the server itself
 * live in `./run.ts`, because the same code also backs `nowtempmail mcp`, the
 * invocation the docs lead with. This file exists so that
 * `npx -y -p nowtempmail nowtempmail-mcp` — and every `.mcp.json` already
 * pointing at this bin — keeps working unchanged.
 *
 * Two details are deliberate:
 *
 * 1. **No top-level `await`.** This entry is built for CJS as well as ESM and a
 *    top-level await breaks the CJS build.
 * 2. **`process.exitCode`, not `process.exit()`.** Exiting mid-flight while a
 *    response body is unread and a timeout handle is live can trip a libuv
 *    assertion on Windows, which surfaces as exit code 127 rather than the code
 *    the command meant to report. Setting `exitCode` lets the event loop drain.
 */

import { runMcpBin } from "./run.js";

const INVOKED_AS = "nowtempmail-mcp";

void runMcpBin(process.argv.slice(2), INVOKED_AS).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${INVOKED_AS} crashed: ${String(err)}\n`);
    process.exitCode = 1;
  },
);
