#!/usr/bin/env node
/**
 * The `nowtempmail` binary. Process wiring only — the logic is in `run.ts`, and
 * for `nowtempmail mcp` in `../mcp/run.ts`.
 *
 * Three details are deliberate and easy to undo by accident:
 *
 * 1. **No top-level `await`.** This entry is bundled to CJS as well as ESM, and
 *    a top-level await breaks the CJS build. An `async function` is fine; a
 *    bare `await` at module scope is not.
 * 2. **`process.exitCode`, not `process.exit()`.** Exiting mid-flight while a
 *    response body is unread and a timeout handle is live can trip a libuv
 *    assertion on Windows, which surfaces as exit code 127 rather than the code
 *    the command meant to report. Setting `exitCode` lets the event loop drain.
 *    The only `process.exit()` here is on a second ⌃C, where the user has asked
 *    twice and an unclean exit is the point.
 * 3. **`mcp` is intercepted before `run()` ever sees the argv.** It has its own
 *    flag set and its own signal handling — a long-lived stdio server ends when
 *    the client closes the pipe, not when this file's AbortController fires. See
 *    `./mcp.ts` for why it is not a row in the COMMANDS table.
 */

import { dispatchMcp } from "./mcp.js";
import { run } from "./run.js";

async function main(argv: readonly string[]): Promise<number> {
  // `nowtempmail mcp …`: hand the rest of argv to the MCP server verbatim.
  const mcpExit = await dispatchMcp(argv);
  if (mcpExit !== undefined) return mcpExit;

  const controller = new AbortController();
  let interrupts = 0;

  const onInterrupt = (): void => {
    interrupts++;
    if (interrupts > 1) {
      // Asked twice. Stop pretending to be graceful.
      process.exit(130);
    }
    controller.abort(new Error("interrupted"));
  };

  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  try {
    return await run({
      argv,
      env: process.env,
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
      isTty: process.stdout.isTTY === true,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // run() handles its own errors; reaching here is a bug in this CLI, and
    // saying so is more useful than a bare stack trace.
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`nowtempmail: internal error\n${message}\n`);
    process.exitCode = 1;
  },
);
