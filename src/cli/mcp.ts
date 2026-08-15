/**
 * `nowtempmail mcp` — the subcommand that is not a command.
 *
 * ## Why this is not in the COMMANDS table
 *
 * Everything in {@link COMMANDS} shares one flag vocabulary and one strict
 * parser: an unrecognised flag is a usage error, deliberately, because a typo'd
 * `--wait` that silently blocks a CI job for 60s is worse than a hard failure.
 * The MCP server has a completely different flag set (`--allow-body-read`,
 * `--max-mailboxes`, and whatever it grows next), and putting it through that
 * parser would mean either teaching the CLI's table about flags it does not own
 * or loosening the unknown-flag rule for every other command. Both are worse
 * than a single interception.
 *
 * So `mcp` is matched on the *first* argv token, before {@link parseArgv} runs,
 * and everything after it is handed to the MCP server untouched — no rewriting,
 * no filtering, not even `--`.
 *
 * ## Why it exists at all
 *
 * `npx -y nowtempmail-mcp` — which 0.1.0's README told people to run — 404s.
 * npx resolves a *package* name and this package is called `nowtempmail`;
 * `nowtempmail-mcp` is only the name of a bin inside it. `npx -y nowtempmail
 * mcp` is the form that matches what users already type, and the direct bin
 * stays available as `npx -y -p nowtempmail nowtempmail-mcp`.
 *
 * The MCP module is loaded with a dynamic `import()` so that `nowtempmail new`
 * never pays for it, and so the optional `@modelcontextprotocol/sdk` peer is
 * only reached when someone actually asks for the server.
 */

import { BIN } from "./help.js";

export const MCP_SUBCOMMAND = "mcp";

/** How the MCP server refers to itself when reached this way. */
export const MCP_INVOCATION = `${BIN} ${MCP_SUBCOMMAND}`;

export type McpRunner = (argv: readonly string[], invokedAs?: string) => Promise<number>;
export type McpLoader = () => Promise<{ runMcpBin: McpRunner }>;

/**
 * The argv the MCP server should see, or `undefined` when this is an ordinary
 * CLI invocation.
 *
 * Only the first token is considered. `nowtempmail ls mcp` is an `ls` of a
 * mailbox unfortunate enough to be called `mcp`, not an MCP server, and
 * `nowtempmail --json mcp` is a usage error from the normal parser — the
 * subcommand comes first, exactly like every other command in this CLI.
 */
export function matchMcpSubcommand(argv: readonly string[]): readonly string[] | undefined {
  return argv[0] === MCP_SUBCOMMAND ? argv.slice(1) : undefined;
}

const loadMcp: McpLoader = () => import("../mcp/run.js");

/**
 * Run the MCP server if `argv` asks for it.
 *
 * @returns the exit code, or `undefined` when this was not an `mcp` invocation
 *   and the caller should carry on into the normal CLI.
 * @param load - Seam for tests, so routing can be proven without starting a
 *   stdio server.
 */
export async function dispatchMcp(
  argv: readonly string[],
  load: McpLoader = loadMcp,
): Promise<number | undefined> {
  const rest = matchMcpSubcommand(argv);
  if (rest === undefined) return undefined;
  const { runMcpBin } = await load();
  return await runMcpBin(rest, MCP_INVOCATION);
}
