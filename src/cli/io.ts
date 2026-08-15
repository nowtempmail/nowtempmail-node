/**
 * The output boundary.
 *
 * Every byte this CLI emits goes through an {@link Io}, for two reasons:
 *
 * 1. **The stdout/stderr split is a contract.** stdout carries data a script
 *    consumes — an address, a code, a table, a JSON document. stderr carries
 *    everything meant for a human: status lines, warnings, errors. `code` in
 *    particular must print the bare code on stdout and nothing else, because
 *    `CODE=$(nowtempmail code …)` is the documented usage.
 * 2. **A final redaction net.** No renderer is supposed to be able to reach the
 *    API key, but "supposed to" is not a guarantee, and a key echoed into CI
 *    logs is a leaked key. {@link createIo} scrubs known secrets from every
 *    chunk on its way out, so a mistake anywhere upstream degrades to
 *    `[redacted]` instead of a credential in a build log.
 */

export interface Io {
  /** Data. Consumed by scripts. Include your own newline. */
  out(text: string): void;
  /** Diagnostics for a human. Include your own newline. */
  err(text: string): void;
}

export interface CreateIoOptions {
  out(text: string): void;
  err(text: string): void;
  /**
   * Values that must never appear in output. Anything shorter than 8 characters
   * is ignored — scrubbing a short string would mangle unrelated text.
   */
  secrets?: ReadonlyArray<string | undefined>;
}

export const REDACTED = "[redacted]";

function collectSecrets(secrets: ReadonlyArray<string | undefined> | undefined): string[] {
  const out: string[] = [];
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string") continue;
    const trimmed = secret.trim();
    if (trimmed.length >= 8) out.push(trimmed);
  }
  // Longest first, so a key is not partially replaced by one of its own prefixes.
  return out.sort((a, b) => b.length - a.length);
}

/**
 * The shortest run of a secret worth hiding on its own.
 *
 * An exact-match scrub is not enough. Renderers truncate untrusted text — `ls`
 * clips a subject to 48 characters — so a key that arrives inside a subject line
 * reaches this function already cut short, and `ntm_live_k7Rm2xQp9Ldv_4nT8wKm…`
 * would sail straight through a whole-string comparison. A partial key is still
 * a leaked key.
 */
const MIN_RUN = 12;

interface SecretTarget {
  value: string;
  /**
   * Where the part that must never be printed starts.
   *
   * A key is `ntm_live_<keyId>_<secret>`, and `keyId` is public — the dashboard
   * shows it and `whoami` is specified to print it. So a run is only scrubbed
   * when it reaches past this index into the secret half; matching the key id
   * alone is not a leak and must not be mangled.
   */
  sensitiveFrom: number;
}

const KEY_SHAPE = /^ntm_(?:live|test)_[^_]+_/;

function toTarget(value: string): SecretTarget {
  const prefix = KEY_SHAPE.exec(value);
  return { value, sensitiveFrom: prefix ? prefix[0].length : 0 };
}

function scrub(text: string, target: SecretTarget): string {
  const { value, sensitiveFrom } = target;
  if (value.length <= MIN_RUN) return text.split(value).join(REDACTED);

  let out = "";
  let i = 0;
  while (i < text.length) {
    const window = text.slice(i, i + MIN_RUN);
    const at = window.length === MIN_RUN ? value.indexOf(window) : -1;
    if (at !== -1) {
      // Grow the match while it still tracks the secret, so the whole visible
      // fragment goes rather than only its first twelve characters.
      let length = MIN_RUN;
      while (i + length < text.length && value.startsWith(text.slice(i, i + length + 1), at)) {
        length++;
      }
      if (at + length > sensitiveFrom) {
        out += REDACTED;
        i += length;
        continue;
      }
    }
    out += text.charAt(i);
    i++;
  }
  return out;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = scrub(out, toTarget(secret));
  }
  return out;
}

export function createIo(options: CreateIoOptions): Io {
  const secrets = collectSecrets(options.secrets);
  if (secrets.length === 0) {
    return { out: options.out, err: options.err };
  }
  const targets = secrets.map(toTarget);
  const clean = (text: string): string => {
    let out = text;
    for (const target of targets) out = scrub(out, target);
    return out;
  };
  return {
    out: (text) => options.out(clean(text)),
    err: (text) => options.err(clean(text)),
  };
}

export interface CaptureIo extends Io {
  /** Everything written to stdout so far. */
  stdout(): string;
  /** Everything written to stderr so far. */
  stderr(): string;
  /** Both streams, for "this string must appear nowhere" assertions. */
  all(): string;
}

/**
 * An {@link Io} that buffers instead of writing. Used by the CLI's own tests to
 * assert the stdout/stderr split without spawning a process.
 */
export function createCaptureIo(secrets: ReadonlyArray<string | undefined> = []): CaptureIo {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io = createIo({
    out: (text) => outChunks.push(text),
    err: (text) => errChunks.push(text),
    secrets,
  });
  return {
    out: io.out,
    err: io.err,
    stdout: () => outChunks.join(""),
    stderr: () => errChunks.join(""),
    all: () => outChunks.join("") + errChunks.join(""),
  };
}
