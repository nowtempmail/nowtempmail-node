/**
 * The MCP server's command line, as a function.
 *
 * `bin.ts` is only a shebang and a process wiring; everything that decides
 * anything lives here — which is what lets the same code back two entry points:
 *
 * - `nowtempmail mcp …` (the documented one), routed from the main CLI binary
 *   in `src/cli/mcp.ts` before the CLI's own flag parser sees the argv, and
 * - `nowtempmail-mcp …`, the direct bin, which is what `npx -p nowtempmail
 *   nowtempmail-mcp` runs.
 *
 * {@link runMcpBin} therefore takes its argv as an argument rather than reading
 * `process.argv`, and **returns** an exit code rather than calling
 * `process.exit()`: exiting mid-flight while a response body is unread and a
 * timeout handle is live can trip a libuv assertion on Windows, which surfaces
 * as 127 instead of the code the command meant to report.
 *
 * Two rules govern output here:
 *
 * 1. **Nothing but protocol frames go to stdout once the transport is up.** A
 *    stray `console.log` corrupts the JSON-RPC stream and the client's failure
 *    looks like a parse error thousands of bytes later. Diagnostics use stderr.
 * 2. **Never accept the key on the command line.** Argv is visible in `ps`, in
 *    shell history, and in the MCP client config files that agents read and
 *    sometimes paste. `NTM_API_KEY` is the only way in.
 */

import { NowTempMail } from "../client.js";
import { NowTempMailError } from "../errors.js";
import { VERSION } from "../http.js";
import { DEFAULT_MAX_MAILBOXES, createMcpServer } from "./index.js";

/** How the server was started, used in usage and diagnostics. */
export const DEFAULT_INVOCATION = "nowtempmail mcp";

interface Args {
  allowBodyRead: boolean;
  maxMailboxes: number;
  baseUrl?: string;
  help: boolean;
  version: boolean;
}

function usage(invokedAs: string): string {
  return `${invokedAs} ${VERSION} — disposable mailboxes and OTP codes over MCP (stdio).

USAGE
  ${invokedAs} [options]

  Speaks the Model Context Protocol on stdin/stdout. It is not meant to be run
  interactively; point an MCP client at it. Example client config:

    {
      "mcpServers": {
        "nowtempmail": {
          "command": "npx",
          "args": ["-y", "nowtempmail@${VERSION}", "mcp"],
          "env": { "NTM_API_KEY": "\${NTM_API_KEY}" }
        }
      }
    }

  The package is \`nowtempmail\` and \`mcp\` is a subcommand of it. There is no
  package called \`nowtempmail-mcp\` — that is the name of a second *bin* in this
  same package, so the direct form needs npx's -p flag:

    npx -y -p nowtempmail@${VERSION} nowtempmail-mcp

  Pin the version and keep the \${NTM_API_KEY} indirection: .mcp.json gets
  committed, and a literal key in it is a published key.

OPTIONS
  --allow-body-read        Register the read_message tool. OFF by default.
                           Message bodies are attacker-controlled text and land
                           verbatim in the model's context; when enabled, bodies
                           are stripped of HTML, truncated to 2000 characters and
                           fenced in an explicit untrusted-content block.
  --max-mailboxes <n>      How many mailboxes this process may create before it
                           refuses. Default ${DEFAULT_MAX_MAILBOXES}. Mailbox creation is the only
                           quota-consuming call and deletion never refunds it, so
                           the cap is what stops a looping agent from spending a
                           whole day's allowance in a minute.
  --base-url <url>         Override the API base URL. Must be https, except
                           localhost. Default https://nowtempmail.com.
  -h, --help               Print this and exit.
  -V, --version            Print the version and exit. (-v also accepted.)

ENVIRONMENT
  NTM_API_KEY              Required. Create a key at
                           https://nowtempmail.com/developers. It is deliberately
                           not accepted as a flag: argv shows up in ps output and
                           in shell history.

TOOLS
  create_mailbox           address + expiry. Capped per process, see above.
  list_messages            id, from, subject, receivedAt, codes. Never bodies,
                           never HTML, never links.
  get_code                 one verification code, shape-checked before it is
                           returned. Refuses anything that is not code-shaped.
  delete_mailbox           confirmation. Does not refund quota.
  read_message             only with --allow-body-read.
`;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    allowBodyRead: false,
    maxMailboxes: DEFAULT_MAX_MAILBOXES,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;

    // `--flag=value` and `--flag value` are both common in MCP client configs.
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq !== -1 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith("--") && eq !== -1 ? raw.slice(eq + 1) : undefined;
    const next = (): string => {
      if (inline !== undefined) return inline;
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value.`);
      return value;
    };

    switch (flag) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      // Both spellings, because the two binaries in this package shipped
      // different ones and the inconsistency is free to fix now and a breaking
      // change later. `nowtempmail` takes -V; accept either here.
      case "-v":
      case "-V":
      case "--version":
        args.version = true;
        break;
      case "--allow-body-read":
        args.allowBodyRead = true;
        break;
      case "--max-mailboxes": {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 0) {
          throw new Error("--max-mailboxes needs a non-negative integer.");
        }
        args.maxMailboxes = value;
        break;
      }
      case "--base-url":
        args.baseUrl = next();
        break;
      default:
        throw new Error(`Unknown option ${flag}. Run with --help.`);
    }
  }

  return args;
}

/**
 * Run the MCP stdio server. Resolves with the exit code the caller should set on
 * `process.exitCode`; resolves only once the transport closes, which for a
 * healthy server means the client closed the pipe.
 *
 * @param argv - Argv without the node binary, the script, or the `mcp`
 *   subcommand: the flags and nothing else.
 * @param invokedAs - How the user spelled it, for usage text and diagnostics.
 */
export async function runMcpBin(
  argv: readonly string[],
  invokedAs: string = DEFAULT_INVOCATION,
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // --help and --version resolve entirely here and exit. A CLI that blocks on
  // stdin when asked for its usage is indistinguishable from a hung one, and
  // that is exactly how an MCP client's first smoke test gets run.
  if (args.help) {
    process.stdout.write(usage(invokedAs));
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const apiKey = process.env.NTM_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write(
      `NTM_API_KEY is not set. ${invokedAs} reads the API key from the ` +
        "environment only — never from argv, which is visible in ps output and in " +
        "shell history. Set it in your MCP client's `env` block for this server. " +
        "Create a key at https://nowtempmail.com/developers.\n",
    );
    return 1;
  }

  let handle: Awaited<ReturnType<typeof createMcpServer>>;
  try {
    const client = new NowTempMail({
      apiKey,
      ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
      userAgentSuffix: "mcp",
    });
    handle = await createMcpServer({
      client,
      allowBodyRead: args.allowBodyRead,
      maxMailboxes: args.maxMailboxes,
    });
    await handle.serveStdio();
  } catch (err) {
    const detail = NowTempMailError.is(err)
      ? `${err.toLogString()} — ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    process.stderr.write(`${invokedAs} failed to start: ${detail}\n`);
    return 1;
  }

  process.stderr.write(
    `${invokedAs} ${VERSION} ready on stdio. ` +
      `tools: ${handle.toolset.definitions.map((t) => t.name).join(", ")}. ` +
      `mailbox cap: ${handle.toolset.budget.limit}.` +
      (args.allowBodyRead
        ? " read_message is ENABLED: message bodies will reach the model, fenced as untrusted content."
        : "") +
      "\n",
  );

  // Resolves when the transport closes, which is how a stdio server is supposed
  // to end: the client closes the pipe.
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle.close().catch(() => undefined);
      resolve();
    };
    process.stdin.on("close", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  return 0;
}
