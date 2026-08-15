/**
 * argv parsing, by hand.
 *
 * Zero runtime dependencies is a hard rule for this package, so there is no
 * commander and no yargs. That turns out to be a feature here: the whole surface
 * is one table, {@link COMMANDS}, which both the parser and `--help` read, so a
 * flag cannot exist in one and be missing from the other.
 *
 * The parser never touches the network, the environment or the process. It takes
 * a string array and returns a value, which is what makes the command surface
 * unit-testable without spawning anything.
 */

export type FlagType = "boolean" | "string" | "integer";

export interface FlagSpec {
  type: FlagType;
  /** Other long names that mean the same flag. `--timeout` for `--wait`. */
  aliases?: readonly string[];
  /** Single letters, written without the dash. */
  shorts?: readonly string[];
  describe: string;
  /** Shown in help after the flag name. */
  placeholder?: string;
}

export interface PositionalSpec {
  name: string;
  required: boolean;
  describe: string;
}

export interface CommandSpec {
  name: string;
  aliases: readonly string[];
  summary: string;
  args: readonly PositionalSpec[];
  flags: Readonly<Record<string, FlagSpec>>;
  /** Longer prose for `nowtempmail help <command>`. */
  detail?: string;
  examples?: readonly string[];
}

export type FlagValue = string | number | boolean;
export type Flags = Readonly<Record<string, FlagValue | undefined>>;

/** Accepted on every command, and listed once in the help output. */
export const GLOBAL_FLAGS: Readonly<Record<string, FlagSpec>> = {
  "base-url": {
    type: "string",
    placeholder: "<url>",
    describe: "Override the API host. Also read from NTM_BASE_URL.",
  },
  json: { type: "boolean", describe: "Machine-readable output on stdout." },
  "no-color": {
    type: "boolean",
    describe: "Never emit ANSI colour. NO_COLOR and a non-TTY stdout do the same.",
  },
  help: { type: "boolean", shorts: ["h"], describe: "Show help for this command." },
};

const ADDRESS_ARG: PositionalSpec = {
  name: "address",
  required: true,
  describe: "A mailbox address, as printed by `new`.",
};

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "new",
    aliases: [],
    summary: "Create a mailbox and print its address",
    args: [],
    flags: {
      domain: {
        type: "string",
        placeholder: "<domain>",
        describe: "Pick a domain from `domains`. Defaults to the rotation's choice.",
      },
      ttl: {
        type: "integer",
        placeholder: "<seconds>",
        describe: "Mailbox lifetime in seconds. 300 to your plan's maximum.",
      },
      address: {
        type: "string",
        placeholder: "<local>",
        describe: "Ask for a specific local part. Requires a paid plan.",
      },
      "wait-code": {
        type: "boolean",
        describe: "After printing the address, wait for a code and print it too.",
      },
      wait: {
        type: "integer",
        placeholder: "<seconds>",
        aliases: ["timeout"],
        describe: "How long --wait-code waits. Default 60.",
      },
    },
    detail:
      "The address goes to stdout on its own line so it can be captured. The\n" +
      "expiry and remaining daily quota go to stderr.",
    examples: ["nowtempmail new", "ADDR=$(nowtempmail new --ttl 900)"],
  },
  {
    name: "tail",
    aliases: [],
    summary: "Watch an inbox and print each message as it arrives",
    args: [ADDRESS_ARG],
    flags: {},
    detail:
      "Runs until interrupted. Mail already in the mailbox is not reprinted —\n" +
      "use `ls` for that. With --json each message is one JSON object per line.",
    examples: ["nowtempmail tail crystal482@allogebra.com"],
  },
  {
    name: "code",
    aliases: [],
    summary: "Wait for a verification code and print just the code",
    args: [ADDRESS_ARG],
    flags: {
      wait: {
        type: "integer",
        placeholder: "<seconds>",
        aliases: ["timeout"],
        describe: "How long to wait before giving up. Default 60.",
      },
      from: {
        type: "string",
        placeholder: "<text>",
        describe: "Only consider mail whose From header contains this.",
      },
      subject: {
        type: "string",
        placeholder: "<text>",
        describe: "Only consider mail whose Subject contains this.",
      },
    },
    detail:
      "stdout carries the bare code and nothing else, so `CODE=$(nowtempmail code\n" +
      "…)` is safe. Exits 4 if the wait elapses with no code.",
    examples: ["CODE=$(nowtempmail code crystal482@allogebra.com --from github)"],
  },
  {
    name: "ls",
    aliases: [],
    summary: "List recent messages as a table",
    args: [ADDRESS_ARG],
    flags: {
      limit: {
        type: "integer",
        placeholder: "<n>",
        describe: "How many messages to show, 1 to 100. Default 25.",
      },
    },
    examples: ["nowtempmail ls crystal482@allogebra.com --limit 5"],
  },
  {
    name: "rm",
    aliases: [],
    summary: "Delete a mailbox and everything in it",
    args: [ADDRESS_ARG],
    flags: {},
    detail: "Daily quota is not refunded by deleting a mailbox.",
    examples: ["nowtempmail rm crystal482@allogebra.com"],
  },
  {
    name: "whoami",
    aliases: ["me"],
    summary: "Plan, limits and live usage for the current key",
    args: [],
    flags: {},
    detail:
      "Prints the key id — the short public identifier — and never the secret,\n" +
      "including under --json.",
    examples: ["nowtempmail whoami"],
  },
  {
    name: "domains",
    aliases: [],
    summary: "List the domains currently accepting mail",
    args: [],
    flags: {},
    examples: ["nowtempmail domains"],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
}

/**
 * The first token that is not a flag and not a flag's value, judged against the
 * global flags alone — which is all that can be known before the command is.
 */
function firstBareToken(tokens: readonly string[]): string | undefined {
  const globals = buildLookup(GLOBAL_FLAGS);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (!token.startsWith("-") || token === "-") return token;
    if (token.includes("=")) continue;
    const spec = GLOBAL_FLAGS[globals.get(token.replace(/^--?/, "")) ?? ""];
    if (spec && spec.type !== "boolean") i++;
  }
  return undefined;
}

export type ParseResult =
  | { kind: "help"; command?: CommandSpec; flags: Flags }
  | { kind: "version"; flags: Flags }
  | { kind: "command"; command: CommandSpec; positionals: string[]; flags: Flags }
  | { kind: "usage-error"; message: string; command?: CommandSpec; flags: Flags };

/** Canonical long name for every spelling of every flag on this command. */
function buildLookup(specs: Readonly<Record<string, FlagSpec>>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [canonical, spec] of Object.entries(specs)) {
    lookup.set(canonical, canonical);
    for (const alias of spec.aliases ?? []) lookup.set(alias, canonical);
    for (const short of spec.shorts ?? []) lookup.set(short, canonical);
  }
  return lookup;
}

/**
 * Parse `process.argv.slice(2)`.
 *
 * Shapes accepted: `--flag`, `--flag value`, `--flag=value`, `-h`, and `--` to
 * end flag parsing. An unknown flag or a missing value is a usage error rather
 * than something quietly ignored — a typo'd `--wait` on a CI job that then
 * blocks for the default 60s is a worse outcome than a hard failure.
 */
export function parseArgv(argv: readonly string[]): ParseResult {
  const first = argv[0];
  if (first === undefined) return { kind: "help", flags: {} };

  // `-v` too: the MCP binary shipped that spelling, and a user who learns one
  // binary should not be corrected by the other.
  if (first === "--version" || first === "-V" || first === "-v") {
    return { kind: "version", flags: {} };
  }

  if (first === "--help" || first === "-h" || first === "help") {
    // `--help --base-url http://…` must not mistake the URL for a command name,
    // so a global flag that takes a value swallows the token after it.
    const wanted = firstBareToken(argv.slice(1));
    if (wanted === undefined) return { kind: "help", flags: {} };
    const command = findCommand(wanted);
    if (!command) {
      return { kind: "usage-error", message: `unknown command \`${wanted}\``, flags: {} };
    }
    return { kind: "help", command, flags: {} };
  }

  if (first.startsWith("-")) {
    return {
      kind: "usage-error",
      message: `unknown flag \`${first}\`. The command comes first: nowtempmail <command> [flags]`,
      flags: {},
    };
  }

  const command = findCommand(first);
  if (!command) {
    return { kind: "usage-error", message: `unknown command \`${first}\``, flags: {} };
  }

  const specs: Record<string, FlagSpec> = { ...GLOBAL_FLAGS, ...command.flags };
  const lookup = buildLookup(specs);
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let literal = false;

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] as string;

    if (literal || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }

    const equals = token.indexOf("=");
    const rawName = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const key = rawName.replace(/^--?/, "");
    const canonical = lookup.get(key);
    if (canonical === undefined) {
      return {
        kind: "usage-error",
        message: `unknown flag \`${rawName}\``,
        command,
        flags,
      };
    }
    const spec = specs[canonical] as FlagSpec;

    if (spec.type === "boolean") {
      if (inline === undefined) {
        flags[canonical] = true;
        continue;
      }
      if (inline === "true" || inline === "false") {
        flags[canonical] = inline === "true";
        continue;
      }
      return {
        kind: "usage-error",
        message: `\`--${canonical}\` is a switch and takes no value`,
        command,
        flags,
      };
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      // A value that looks like a flag is almost always a forgotten argument.
      if (next === undefined || (next.startsWith("-") && next.length > 1)) {
        return {
          kind: "usage-error",
          message: `\`--${canonical}\` needs a value`,
          command,
          flags,
        };
      }
      value = next;
      i++;
    }

    if (spec.type === "integer") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return {
          kind: "usage-error",
          message: `\`--${canonical}\` needs a positive whole number, got \`${value}\``,
          command,
          flags,
        };
      }
      flags[canonical] = parsed;
      continue;
    }

    if (value === "") {
      return {
        kind: "usage-error",
        message: `\`--${canonical}\` needs a value`,
        command,
        flags,
      };
    }
    flags[canonical] = value;
  }

  if (flags.help === true) return { kind: "help", command, flags };

  if (positionals.length > command.args.length) {
    const extra = positionals[command.args.length] as string;
    return {
      kind: "usage-error",
      message: `unexpected argument \`${extra}\``,
      command,
      flags,
    };
  }
  for (let i = 0; i < command.args.length; i++) {
    const arg = command.args[i] as PositionalSpec;
    if (arg.required && !positionals[i]) {
      return {
        kind: "usage-error",
        message: `\`<${arg.name}>\` is required`,
        command,
        flags,
      };
    }
  }

  return { kind: "command", command, positionals, flags };
}

/* -------------------------------------------------------------------------- */
/* Typed readers                                                              */
/* -------------------------------------------------------------------------- */

export function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagInteger(flags: Flags, name: string): number | undefined {
  const value = flags[name];
  return typeof value === "number" ? value : undefined;
}

export function flagBoolean(flags: Flags, name: string): boolean {
  return flags[name] === true;
}
