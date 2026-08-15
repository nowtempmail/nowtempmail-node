/**
 * A retrieved message and its attachments.
 *
 * Everything on these classes is derived from one `GET
 * /v1/mailboxes/{address}/messages/{id}` response. Nothing here makes a second
 * request except `Attachment.download()`.
 *
 * Inbound mail is attacker-controlled. `from`, `subject`, the bodies, every
 * `filename` and every link came from whoever sent the mail, and none of it has
 * been sanitised. Treat it as untrusted input in your own code.
 */

import type { Http } from "./http.js";
import type { WireAttachment, WireMessage } from "./types.js";

/** Matches `Display Name <addr@host>` and pulls out the addr-spec. */
const ANGLE_ADDRESS = /<([^<>]+)>/;
/** Something that could plausibly be a bare addr-spec. */
const BARE_ADDRESS = /^[^\s<>@]+@[^\s<>@]+$/;
/**
 * URLs in a body. Stops at whitespace and at the characters that most often
 * *follow* a URL in prose or markup rather than belonging to it.
 */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
/** Trailing punctuation a sentence leaves stuck to the end of a URL. */
const TRAILING_JUNK = /[.,;:!?'"”’)\]}]+$/;

export class Attachment {
  readonly id: string;
  /**
   * The filename the sender supplied.
   *
   * **SENDER-CONTROLLED.** It is not sanitised, not unique, and not validated:
   * it can contain `../`, an absolute path, a NUL, a right-to-left override that
   * makes `evil.exe` render as `evilexe.txt`, or 4KB of nothing. Never join it
   * onto a path, never use it as a key, and never pass it to a shell. If you
   * must write the bytes somewhere, generate your own name.
   */
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;

  readonly #http: Http;
  readonly #address: string;
  readonly #messageId: string;

  constructor(http: Http, address: string, messageId: string, wire: WireAttachment) {
    this.#http = http;
    this.#address = address;
    this.#messageId = messageId;
    this.id = wire.id;
    this.filename = wire.filename;
    this.contentType = wire.contentType;
    this.size = wire.size;
  }

  /**
   * Fetch the attachment content.
   *
   * Returns bytes in memory and **never writes to disk** — deciding where
   * untrusted bytes with a sender-chosen name land is the caller's call, not
   * this SDK's. See the warning on {@link Attachment.filename} before you use
   * the returned `filename` for anything other than display.
   */
  async download(): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
    const path =
      `/v1/mailboxes/${encodeURIComponent(this.#address)}` +
      `/messages/${encodeURIComponent(this.#messageId)}` +
      `/attachments/${encodeURIComponent(this.id)}`;
    const res = await this.#http.request<Uint8Array>({ method: "GET", path, raw: true });
    return {
      bytes: res.data,
      // The response header is authoritative; the metadata may predate a
      // re-parse. Fall back to what the listing said.
      contentType: res.headers.get("Content-Type") ?? this.contentType,
      filename: this.filename,
    };
  }
}

export class Message {
  readonly id: string;
  /** The raw `From` header — often `Display Name <addr@host>`, not a bare address. */
  readonly from: string;
  /** The addr-spec pulled out of `from`, or `null` when there is nothing to pull. */
  readonly fromAddress: string | null;
  /** The mailbox this was read from. Not stored on the message record. */
  readonly to: string;
  readonly subject: string;
  readonly receivedAt: Date;
  readonly text: string | null;
  readonly html: string | null;
  /** Extracted server-side on ingest, which is why there is no regex here. */
  readonly verificationCodes: string[];
  readonly attachments: Attachment[];

  constructor(http: Http, address: string, wire: WireMessage) {
    this.id = wire.id;
    this.from = wire.from;
    this.fromAddress = parseFromAddress(wire.from);
    this.to = wire.to || address;
    this.subject = wire.subject;
    this.receivedAt = new Date(wire.receivedAt * 1000);
    this.text = wire.text;
    this.html = wire.html;
    this.verificationCodes = [...wire.verificationCodes];
    this.attachments = wire.attachments.map((a) => new Attachment(http, address, wire.id, a));
  }

  /** The first verification code, or `null` when the message carries none. */
  get code(): string | null {
    return this.verificationCodes[0] ?? null;
  }

  /**
   * URLs found in the text and HTML bodies, deduped, in the order they appear
   * (text body first). Values that do not parse as a URL are dropped.
   *
   * These are links a stranger put in an email. A password-reset link is a live
   * credential; do not log one, and do not fetch one you did not expect.
   */
  links(): URL[] {
    const seen = new Set<string>();
    const out: URL[] = [];
    for (const body of [this.text, this.html]) {
      if (!body) continue;
      for (const raw of body.match(URL_IN_TEXT) ?? []) {
        const trimmed = raw.replace(TRAILING_JUNK, "");
        if (!trimmed) continue;
        let url: URL;
        try {
          url = new URL(decodeHtmlEntities(trimmed));
        } catch {
          continue;
        }
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        out.push(url);
      }
    }
    return out;
  }
}

function parseFromAddress(from: string): string | null {
  const angled = ANGLE_ADDRESS.exec(from);
  const candidate = (angled?.[1] ?? from).trim();
  if (!candidate) return null;
  if (!BARE_ADDRESS.test(candidate)) return null;
  return candidate;
}

/** The five entities an HTML body realistically puts inside an href. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'");
}
