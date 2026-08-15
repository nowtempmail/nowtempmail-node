/**
 * Terminal formatting primitives. No dependencies — raw ANSI, hand-rolled
 * padding.
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 * 1. {@link createPalette} takes a single boolean and, when it is false, returns
 *    identity functions. Colour is therefore decided once (NO_COLOR, --no-color,
 *    not a TTY) and no renderer has to remember to check again.
 * 2. {@link sanitiseForTerminal} exists because `from`, `subject` and attachment
 *    filenames are attacker-controlled. An escape sequence in a subject line can
 *    retitle the user's terminal or overwrite the line above it, and a
 *    right-to-left override makes `evil.exe` render as `evilexe.txt`. Everything
 *    that came out of an email goes through it before it is printed.
 */

/** ESC[ — built from a char code so no literal control byte lives in the source. */
export const CSI = `${String.fromCharCode(27)}[`;

export interface Palette {
  readonly enabled: boolean;
  dim(text: string): string;
  bold(text: string): string;
  red(text: string): string;
  /** A warning that is not fatal — a rate limit we are waiting out. */
  amber(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
}

const IDENTITY: Palette = {
  enabled: false,
  dim: (t) => t,
  bold: (t) => t,
  red: (t) => t,
  amber: (t) => t,
  green: (t) => t,
  cyan: (t) => t,
};

function wrap(code: string): (text: string) => string {
  return (text: string) => `${CSI}${code}m${text}${CSI}0m`;
}

export function createPalette(enabled: boolean): Palette {
  if (!enabled) return IDENTITY;
  return {
    enabled: true,
    dim: wrap("2"),
    bold: wrap("1"),
    red: wrap("31"),
    amber: wrap("33"),
    green: wrap("32"),
    cyan: wrap("36"),
  };
}

/**
 * A duration a human would say out loud.
 *
 * Rounds to the nearest minute above 90 seconds, which is why a mailbox created
 * 300ms ago reads as `24h` rather than `23h 59m`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** `HH:MM:SS`, local time. */
export function formatClock(when: Date): string {
  if (Number.isNaN(when.getTime())) return "--:--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

export function truncate(value: string, max: number): string {
  if (max <= 1 || value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Code points that must never reach a terminal from untrusted mail. */
function isUnsafeCodePoint(code: number): boolean {
  if (code <= 0x1f || code === 0x7f) return true; // C0 controls and DEL
  if (code >= 0x80 && code <= 0x9f) return true; // C1 controls
  if (code === 0x200e || code === 0x200f) return true; // LRM / RLM
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embedding/override
  if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
  if (code === 0xfeff) return true; // BOM / zero-width no-break space
  return false;
}

/**
 * Replace every terminal-steering code point with a space, then collapse runs
 * of whitespace. Used on `from`, `subject` and attachment filenames.
 */
export function sanitiseForTerminal(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += isUnsafeCodePoint(code) ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A left-aligned column layout. Two spaces between columns, no trailing
 * whitespace, and the last column is never padded so a copy-paste is clean.
 */
export function renderTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  palette: Palette = IDENTITY,
): string {
  const widths = headers.map((header, i) => {
    let width = header.length;
    for (const row of rows) width = Math.max(width, (row[i] ?? "").length);
    return width;
  });
  const layout = (cells: readonly string[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < headers.length; i++) {
      const cell = cells[i] ?? "";
      parts.push(i === headers.length - 1 ? cell : cell.padEnd(widths[i] ?? 0));
    }
    return parts.join("  ").replace(/\s+$/, "");
  };
  const lines = [palette.dim(layout(headers))];
  for (const row of rows) lines.push(layout(row));
  return `${lines.join("\n")}\n`;
}
