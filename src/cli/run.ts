/**
 * The CLI's body. `bin.ts` is only a shebang and a process wiring; everything
 * that decides anything lives here.
 *
 * `run()` **returns** an exit code and never calls `process.exit()`. That is not
 * tidiness: on Windows, exiting while a fetch body is unread and an
 * `AbortSignal.timeout` handle is still live can trip a libuv assertion and the
 * process reports 127 instead of the code you meant. Returning a number lets
 * `bin.ts` set `process.exitCode` and let the loop drain, and it is also what
 * makes the whole surface testable without spawning a subprocess.
 */

import { NowTempMail } from "../client.js";
import { VERSION } from "../http.js";
import { flagString, parseArgv, type Flags } from "./args.js";
import { newCommand } from "./commands/new.js";
import { codeCommand } from "./commands/code.js";
import { domainsCommand } from "./commands/domains.js";
import { lsCommand } from "./commands/ls.js";
import { rmCommand } from "./commands/rm.js";
import { tailCommand } from "./commands/tail.js";
import { whoamiCommand } from "./commands/whoami.js";
import { warn, type CliContext } from "./context.js";
import {
  EXIT,
  NO_API_KEY_MESSAGE,
  describeError,
  formatErrorLine,
  rateLimitNotice,
} from "./errors.js";
import { renderCommandHelp, renderUsage, renderUsageHint } from "./help.js";
import { createIo } from "./io.js";
import { createPalette } from "./style.js";
import type { ResponseHookEvent } from "../http.js";

export type Env = Record<string, string | undefined>;

export interface RunOptions {
  argv: readonly string[];
  env: Env;
  out(text: string): void;
  err(text: string): void;
  /** stdout is a terminal. Gates ANSI colour. */
  isTty?: boolean;
  /** Aborted on ⌃C. */
  signal?: AbortSignal;
}

function readEnv(env: Env, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Colour is on only when a human is looking at it: a terminal on stdout, no
 * `NO_COLOR`, no `--no-color`. Piped output is always plain, and nothing in this
 * CLI ever redraws a line in place.
 */
function wantsColor(env: Env, flags: Flags, isTty: boolean): boolean {
  if (flags["no-color"] === true) return false;
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return isTty;
}

/** A 429 whose per-minute budget is exhausted. Quota 429s look different. */
function isRateLimitResponse(event: ResponseHookEvent): boolean {
  return event.status === 429 && event.metering.rateLimit?.remaining === 0;
}

export async function run(options: RunOptions): Promise<number> {
  const { env } = options;
  const parsed = parseArgv(options.argv);
  const flags: Flags = "flags" in parsed ? parsed.flags : {};

  const apiKey = readEnv(env, "NTM_API_KEY");
  // Everything written from here on is scrubbed of the key, whatever a renderer
  // does upstream.
  const io = createIo({ out: options.out, err: options.err, secrets: [apiKey] });
  const palette = createPalette(wantsColor(env, flags, options.isTty === true));
  const json = flags.json === true;

  if (parsed.kind === "version") {
    io.out(`${VERSION}\n`);
    return EXIT.OK;
  }

  if (parsed.kind === "help") {
    io.out(
      parsed.command ? renderCommandHelp(parsed.command, palette) : renderUsage(palette, VERSION),
    );
    return EXIT.OK;
  }

  if (parsed.kind === "usage-error") {
    io.err(formatErrorLine({ message: parsed.message, exit: EXIT.USAGE }, palette));
    io.err(palette.dim(renderUsageHint(parsed.command)));
    return EXIT.USAGE;
  }

  const { command, positionals } = parsed;

  if (apiKey === undefined) {
    io.err(formatErrorLine({ message: NO_API_KEY_MESSAGE, exit: EXIT.USAGE }, palette));
    return EXIT.USAGE;
  }

  const baseUrl = flagString(flags, "base-url") ?? readEnv(env, "NTM_BASE_URL");
  const pollOverride = Number(readEnv(env, "NTM_POLL_INTERVAL_MS") ?? "");
  const pollIntervalMs =
    Number.isFinite(pollOverride) && pollOverride > 0 ? Math.round(pollOverride) : undefined;

  // Assigned immediately below; the hook only ever runs after that.
  let ctx!: CliContext;
  let client: NowTempMail;
  try {
    client = new NowTempMail({
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      // A rate limit is not a failure: the SDK is already waiting out the
      // window, so this is a status line and the command continues.
      onResponse: (event) => {
        if (!isRateLimitResponse(event)) return;
        const reset = event.metering.rateLimit?.reset;
        const seconds = reset ? Math.ceil((reset.getTime() - Date.now()) / 1000) : 1;
        warn(
          ctx,
          rateLimitNotice({
            retryAfterSeconds: Math.min(120, Math.max(1, seconds)),
            ...(event.metering.rateLimit === null
              ? {}
              : { limit: event.metering.rateLimit.limit }),
            ...(ctx.planLabel === undefined ? {} : { planLabel: ctx.planLabel }),
          }),
        );
      },
    });
  } catch (err) {
    // A bad --base-url, or an http URL that is not localhost.
    const described = describeError(err, { baseUrl });
    io.err(formatErrorLine(described, palette));
    return described.exit;
  }

  ctx = {
    io,
    palette,
    json,
    client,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  };

  const address = positionals[0];

  try {
    switch (command.name) {
      case "new":
        return await newCommand(ctx, flags);
      case "tail":
        return await tailCommand(ctx, flags, address as string);
      case "code":
        return await codeCommand(ctx, flags, address as string);
      case "ls":
        return await lsCommand(ctx, flags, address as string);
      case "rm":
        return await rmCommand(ctx, flags, address as string);
      case "whoami":
        return await whoamiCommand(ctx);
      case "domains":
        return await domainsCommand(ctx);
      default:
        // Unreachable: parseArgv only returns commands from its own table.
        io.err(formatErrorLine({ message: `unknown command \`${command.name}\``, exit: EXIT.USAGE }, palette));
        return EXIT.USAGE;
    }
  } catch (err) {
    const described = describeError(err, {
      metering: client.metering,
      ...(address === undefined ? {} : { address }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(ctx.planLabel === undefined ? {} : { planLabel: ctx.planLabel }),
    });
    io.err(formatErrorLine(described, palette));
    return described.exit;
  }
}
