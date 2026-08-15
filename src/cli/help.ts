/**
 * Help text, generated from the same {@link COMMANDS} table the parser uses.
 *
 * Written by hand rather than by a framework, which means the ordering is
 * editorial: what you probably want first, then how to authenticate, then the
 * exit codes — because the exit codes are the part a CI script depends on and
 * the part nobody can guess.
 */

import { COMMANDS, GLOBAL_FLAGS, type CommandSpec, type FlagSpec } from "./args.js";
import { KEYS_URL } from "./errors.js";
import type { Palette } from "./style.js";

export const BIN = "nowtempmail";

function flagLabel(name: string, spec: FlagSpec): string {
  const shorts = (spec.shorts ?? []).map((s) => `-${s}, `).join("");
  const aliases = (spec.aliases ?? []).map((a) => `, --${a}`).join("");
  const placeholder = spec.placeholder ? ` ${spec.placeholder}` : "";
  return `${shorts}--${name}${aliases}${placeholder}`;
}

/** Two-column rows, aligned as a group so nothing drifts out of line. */
function describeRows(rows: ReadonlyArray<readonly [string, string]>, palette: Palette): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, describe]) => `  ${label.padEnd(width)}  ${palette.dim(describe)}`);
}

function flagRows(
  specs: Readonly<Record<string, FlagSpec>>,
): Array<readonly [string, string]> {
  return Object.entries(specs).map(([name, spec]) => [flagLabel(name, spec), spec.describe]);
}

function flagLines(specs: Readonly<Record<string, FlagSpec>>, palette: Palette): string[] {
  return describeRows(flagRows(specs), palette);
}

function usageLine(command: CommandSpec): string {
  const args = command.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  const flags = Object.keys(command.flags).length > 0 ? " [flags]" : "";
  return `${BIN} ${command.name}${args ? ` ${args}` : ""}${flags}`;
}

/** The top-level `--help`. */
export function renderUsage(palette: Palette, version: string): string {
  const names = COMMANDS.map((c) => {
    const args = c.args.map((a) => `<${a.name}>`).join(" ");
    return `${c.name}${args ? ` ${args}` : ""}`;
  });
  const width = Math.max(...names.map((n) => n.length));

  const commandLines = COMMANDS.map((command, i) => {
    const alias = command.aliases.length > 0 ? ` (alias: ${command.aliases.join(", ")})` : "";
    return `  ${(names[i] ?? "").padEnd(width)}  ${palette.dim(command.summary + alias)}`;
  });

  return [
    `${palette.bold(BIN)} ${palette.dim(version)} — disposable mailboxes and OTP codes, from your shell`,
    "",
    palette.bold("usage"),
    `  ${BIN} <command> [flags]`,
    "",
    palette.bold("commands"),
    ...commandLines,
    "",
    palette.bold("global flags"),
    ...describeRows(
      [...flagRows(GLOBAL_FLAGS), ["-V, --version", "Print the version."] as const],
      palette,
    ),
    "",
    palette.bold("credentials"),
    `  ${palette.dim(`NTM_API_KEY is the only credential this CLI reads. It writes no config file`)}`,
    `  ${palette.dim(`and creates no dotfile. Create a key at ${KEYS_URL}`)}`,
    "",
    palette.bold("output"),
    `  ${palette.dim("stdout is data — an address, a code, a table, JSON. stderr is for humans,")}`,
    `  ${palette.dim("so `CODE=$(nowtempmail code …)` captures the code and nothing else.")}`,
    "",
    palette.bold("exit codes"),
    `  0  ${palette.dim("success")}`,
    `  1  ${palette.dim("API or runtime failure, including a spent daily quota")}`,
    `  2  ${palette.dim("usage error, or a missing or rejected API key")}`,
    `  4  ${palette.dim("a --wait window elapsed with no match")}`,
    "",
    palette.bold("examples"),
    `  ${BIN} new`,
    `  CODE=$(${BIN} code crystal482@allogebra.com --from github --wait 120)`,
    `  ${BIN} tail crystal482@allogebra.com --json`,
    "",
  ].join("\n");
}

/** `nowtempmail help <command>` and `nowtempmail <command> --help`. */
export function renderCommandHelp(command: CommandSpec, palette: Palette): string {
  const lines: string[] = [
    `${palette.bold(`${BIN} ${command.name}`)} — ${command.summary}`,
    "",
    palette.bold("usage"),
    `  ${usageLine(command)}`,
  ];

  if (command.args.length > 0) {
    lines.push("", palette.bold("arguments"));
    const width = Math.max(...command.args.map((a) => a.name.length + 2));
    for (const arg of command.args) {
      lines.push(`  ${`<${arg.name}>`.padEnd(width)}  ${palette.dim(arg.describe)}`);
    }
  }

  if (Object.keys(command.flags).length > 0) {
    lines.push("", palette.bold("flags"), ...flagLines(command.flags, palette));
  }

  lines.push("", palette.bold("global flags"), ...flagLines(GLOBAL_FLAGS, palette));

  if (command.detail) {
    lines.push("", palette.bold("notes"));
    for (const line of command.detail.split("\n")) lines.push(`  ${palette.dim(line)}`);
  }

  if (command.examples && command.examples.length > 0) {
    lines.push("", palette.bold("examples"));
    for (const example of command.examples) lines.push(`  ${example}`);
  }

  lines.push("");
  return lines.join("\n");
}

/** The two-line hint a usage error prints under its message. */
export function renderUsageHint(command: CommandSpec | undefined): string {
  if (!command) return `run \`${BIN} --help\` for the command list\n`;
  return `usage: ${usageLine(command)}\nrun \`${BIN} help ${command.name}\` for the flags\n`;
}
