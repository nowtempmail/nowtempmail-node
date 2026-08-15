/**
 * The mailbox handle. This is the object a test spends its time with.
 *
 * The interesting decisions all live in `#watch`, and all of them come from how
 * a live inbox actually behaves rather than from what reads nicely:
 *
 * - The high-water mark defaults to the mailbox's `createdAt`, not to the moment
 *   `waitForCode` was called. Mail routinely lands before anyone waits for it —
 *   a signup form submits, the mail arrives in 300ms, and the test gets around
 *   to waiting a second later. Defaulting to call time makes that message
 *   invisible and produces a flake nobody can reproduce.
 * - It polls page one and never paginates. New mail arrives at the *front* of
 *   the list, so a cursor walk started at page one can miss a message that
 *   lands mid-walk.
 * - One request in flight per handle. Two overlapping polls double the request
 *   rate for no extra freshness and bring the 429 forward.
 * - A 429 sleeps for exactly `Retry-After` rather than a backoff guess, because
 *   the server knows when the fixed minute window resets and we do not.
 */

import { ConnectionError, NowTempMailError, TimeoutError } from "./errors.js";
import { sleep } from "./http.js";
import type { Http } from "./http.js";
import { Message } from "./message.js";
import type {
  MessagePage,
  MessageSummary,
  WireMailbox,
  WireMailboxDeleted,
  WireMessage,
  WireMessageList,
  WireMessageSummary,
} from "./types.js";

/** ±15%, so N watchers on one key do not synchronise into a thundering herd. */
const JITTER = 0.15;

export interface MessageFilter {
  /** Tested against the raw `From` header. A string matches case-insensitively as a substring. */
  from?: string | RegExp;
  /** Tested against the subject. A string matches case-insensitively as a substring. */
  subject?: string | RegExp;
  /** Only consider mail received at/after this. Default: mailbox `createdAt`. */
  after?: Date;
  /** Shorthand for `after = now`. For resend flows, where the stale code is the bug. */
  ignoreExisting?: boolean;
  match?(m: MessageSummary): boolean;
  /** Default 60_000. */
  timeoutMs?: number;
  /**
   * Override the poll interval. Honoured verbatim — no floor and no jitter is
   * applied to an explicit value. Omit it and the interval is derived from the
   * key's `X-RateLimit-Limit` divided across active watchers.
   */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface MailboxInit {
  address: string;
  /** Only `POST /v1/mailboxes` reports this; derived from the address otherwise. */
  domain?: string;
  createdAt?: Date | null;
  expiresAt?: Date | null;
  /** Only `POST` reports this; derived from `expiresAt - createdAt` otherwise. */
  ttlSeconds?: number;
  /** Only `POST` reports this. */
  reserved?: boolean;
  /** Only `POST` reports this. */
  webhookUrl?: string | null;
  messageCount?: number;
  lastMessageAt?: Date | null;
  confirmed?: boolean;
}

const UNKNOWN_DATE = new Date(0);

export class Mailbox {
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;

  /**
   * `POST /v1/mailboxes` reports these four; `GET /v1/mailboxes/{address}` does
   * not. They are therefore set once, at construction, and `refresh()` leaves
   * them alone — overwriting them with the `undefined` a narrower response
   * carries would silently destroy them.
   */
  readonly ttlSeconds: number;
  readonly reserved: boolean;
  readonly webhookUrl: string | null;

  readonly #http: Http;
  #createdAt: Date | null;
  #expiresAt: Date | null;
  #messageCount: number;
  #lastMessageAt: Date | null;
  #confirmed: boolean;
  /** Serialises every request this handle makes. See the note at the top. */
  #tail: Promise<void> = Promise.resolve();

  constructor(http: Http, init: MailboxInit) {
    this.#http = http;
    this.address = init.address.trim().toLowerCase();
    const at = this.address.lastIndexOf("@");
    this.localPart = at === -1 ? this.address : this.address.slice(0, at);
    this.domain = init.domain ?? (at === -1 ? "" : this.address.slice(at + 1));

    this.#createdAt = init.createdAt ?? null;
    this.#expiresAt = init.expiresAt ?? null;
    this.#messageCount = init.messageCount ?? 0;
    this.#lastMessageAt = init.lastMessageAt ?? null;
    this.#confirmed = init.confirmed ?? false;

    this.ttlSeconds = init.ttlSeconds ?? derivedTtl(this.#createdAt, this.#expiresAt);
    this.reserved = init.reserved ?? false;
    this.webhookUrl = init.webhookUrl ?? null;
  }

  /**
   * When the mailbox was created. Reads as the Unix epoch on a handle from
   * `attach()`, which has not talked to the API — that is deliberate, since it
   * makes `waitFor*` consider every message already in the inbox.
   */
  get createdAt(): Date {
    return this.#createdAt ?? UNKNOWN_DATE;
  }

  /** Reads as the Unix epoch until known. Check {@link expired} instead of comparing. */
  get expiresAt(): Date {
    return this.#expiresAt ?? UNKNOWN_DATE;
  }

  get messageCount(): number {
    return this.#messageCount;
  }

  /** Timestamp of the newest message, as of the last read. */
  get lastMessageAt(): Date | null {
    return this.#lastMessageAt;
  }

  /** False when create-then-confirm could not verify readability in time. */
  get confirmed(): boolean {
    return this.#confirmed;
  }

  /** False when the expiry is not known yet (an `attach()` handle before `refresh()`). */
  get expired(): boolean {
    return this.#expiresAt === null ? false : Date.now() >= this.#expiresAt.getTime();
  }

  /** `Infinity` when the expiry is not known yet. */
  get expiresInMs(): number {
    if (this.#expiresAt === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.#expiresAt.getTime() - Date.now());
  }

  /**
   * Re-read the mailbox metadata.
   *
   * Only `createdAt`, `expiresAt`, `messageCount` and `lastMessageAt` are
   * updated: `GET /v1/mailboxes/{address}` does not return `domain`,
   * `ttlSeconds`, `reserved` or `webhookUrl`, so those keep whatever creation
   * told us.
   */
  async refresh(): Promise<this> {
    const res = await this.#serialised(() =>
      this.#http.request<WireMailbox>({ method: "GET", path: this.#path() }),
    );
    const wire = res.data;
    this.#createdAt = new Date(wire.createdAt * 1000);
    this.#expiresAt = new Date(wire.expiresAt * 1000);
    this.#messageCount = wire.messageCount;
    this.#lastMessageAt = wire.lastMessageAt === null ? null : new Date(wire.lastMessageAt * 1000);
    this.#confirmed = true;
    return this;
  }

  /** Deletes the mailbox and every message in it. Not reversible, and no quota is refunded. */
  async delete(): Promise<{ deletedMessages: number }> {
    const res = await this.#serialised(() =>
      this.#http.request<WireMailboxDeleted>({ method: "DELETE", path: this.#path() }),
    );
    this.#messageCount = 0;
    return { deletedMessages: res.data.deletedMessages ?? 0 };
  }

  readonly messages = {
    /** One page of summaries, newest first. `limit` 1-100, default 25. */
    page: async (opts: { limit?: number; cursor?: string } = {}): Promise<MessagePage> => {
      const res = await this.#serialised(() =>
        this.#http.request<WireMessageList>({
          method: "GET",
          path: `${this.#path()}/messages`,
          query: { limit: opts.limit, cursor: opts.cursor },
        }),
      );
      const page: MessagePage = {
        messages: res.data.messages.map(toSummary),
        hasMore: res.data.hasMore,
        nextCursor: res.data.nextCursor,
      };
      const newest = page.messages[0];
      if (newest && !opts.cursor) this.#lastMessageAt = newest.receivedAt;
      return page;
    },

    /**
     * Walk the mailbox's **history**, auto-paginating with `nextCursor` until
     * the list ends.
     *
     * This is **not** how you watch a live inbox — use {@link waitForMessage} or
     * {@link waitForCode} for that. Messages are ordered newest first, so a
     * message that arrives while this iterator is partway through the mailbox
     * lands at the *front* of the list, behind the cursor, and is never yielded.
     * A cursor walk is only correct over a set that is not growing.
     */
    list: (opts: { limit?: number } = {}): AsyncIterableIterator<MessageSummary> =>
      this.#iterate(opts.limit),

    /** The full message: bodies and attachment metadata. */
    get: async (id: string): Promise<Message> => {
      const res = await this.#serialised(() =>
        this.#http.request<WireMessage>({
          method: "GET",
          path: `${this.#path()}/messages/${encodeURIComponent(id)}`,
        }),
      );
      return new Message(this.#http, this.address, res.data);
    },

    /** Deletes one message and its stored body. A second call is a 404. */
    delete: async (id: string): Promise<void> => {
      await this.#serialised(() =>
        this.#http.request<unknown>({
          method: "DELETE",
          path: `${this.#path()}/messages/${encodeURIComponent(id)}`,
        }),
      );
      this.#messageCount = Math.max(0, this.#messageCount - 1);
    },
  };

  /**
   * Wait for a matching message and resolve with the full message, bodies
   * included. Polls page one and dedupes by id.
   *
   * Throws `TimeoutError` — carrying `messagesSeen`, which is the number that
   * tells you whether nothing arrived or nothing matched — if the timeout
   * elapses first.
   */
  async waitForMessage(filter: MessageFilter = {}): Promise<Message> {
    const summary = await this.#watch("a message", filter, (m) => m);
    return this.messages.get(summary.id);
  }

  /**
   * The hero method. Resolves with the first verification code on the first
   * matching message.
   *
   * Never fetches a body: codes ride on the summary because they are extracted
   * server-side at ingest, so this is one request per poll and no message
   * content is transferred.
   */
  async waitForCode(filter: MessageFilter = {}): Promise<string> {
    return this.#watch("a verification code", filter, (m) => m.verificationCodes[0]);
  }

  /* ---------------------------------------------------------------------- */

  #path(): string {
    return `/v1/mailboxes/${encodeURIComponent(this.address)}`;
  }

  /** One request in flight per handle, in call order. */
  async #serialised<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async *#iterate(limit?: number): AsyncIterableIterator<MessageSummary> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.messages.page({ limit, cursor });
      for (const message of page.messages) {
        // A deleted message shifts the window; never yield the same id twice.
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        yield message;
      }
      if (!page.hasMore || !page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  async #watch<T>(
    what: string,
    filter: MessageFilter,
    pick: (m: MessageSummary) => T | undefined,
  ): Promise<T> {
    const startedAt = Date.now();
    const timeoutMs = filter.timeoutMs ?? 60_000;
    const explicitInterval = filter.pollIntervalMs;
    const after = highWaterMark(filter, this.createdAt);
    const signal = filter.signal;

    const seen = new Set<string>();
    let messagesSeen = 0;

    const deregister = this.#http.registerWatcher();
    try {
      for (;;) {
        throwIfAborted(signal);

        let page: MessagePage;
        try {
          page = await this.messages.page({ limit: 25 });
        } catch (err) {
          // The transport already retried and slept for Retry-After. Landing
          // here means the window is genuinely exhausted, so wait it out rather
          // than failing a wait the caller expects to be patient.
          const wait = rateLimitPause(err);
          if (wait === null) throw err;
          const remaining = timeoutMs - (Date.now() - startedAt);
          if (remaining <= 0) break;
          await sleep(Math.min(wait, remaining), signal);
          continue;
        }

        // Newest first, as the API returns it: on a resend the freshest code is
        // the one the caller wants.
        for (const message of page.messages) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          messagesSeen++;
          if (message.receivedAt.getTime() < after) continue;
          if (!matches(message, filter)) continue;
          const value = pick(message);
          if (value !== undefined) return value;
        }

        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        const wait =
          explicitInterval !== undefined
            ? explicitInterval
            : jitter(this.#http.pollIntervalMs(this.#http.watchers));
        await sleep(Math.min(wait, remaining), signal);
      }
    } finally {
      deregister();
    }

    throw new TimeoutError({
      address: this.address,
      waitedMs: Date.now() - startedAt,
      messagesSeen,
      what,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toSummary(wire: WireMessageSummary): MessageSummary {
  return {
    id: wire.id,
    from: wire.from,
    subject: wire.subject,
    receivedAt: new Date(wire.receivedAt * 1000),
    attachmentCount: wire.attachmentCount,
    verificationCodes: [...wire.verificationCodes],
  };
}

function derivedTtl(createdAt: Date | null, expiresAt: Date | null): number {
  if (!createdAt || !expiresAt) return 0;
  return Math.max(0, Math.round((expiresAt.getTime() - createdAt.getTime()) / 1000));
}

/** Epoch ms. Mail older than this is ignored. */
function highWaterMark(filter: MessageFilter, createdAt: Date): number {
  if (filter.ignoreExisting) return Date.now();
  if (filter.after) return filter.after.getTime();
  return createdAt.getTime();
}

function matches(message: MessageSummary, filter: MessageFilter): boolean {
  if (filter.from !== undefined && !textMatches(message.from, filter.from)) return false;
  if (filter.subject !== undefined && !textMatches(message.subject, filter.subject)) return false;
  if (filter.match && !filter.match(message)) return false;
  return true;
}

function textMatches(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  // A stateful /g regex would skip alternate calls; test from the start.
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/** ms to wait on a rate-limit error, or `null` if this error is not one. */
function rateLimitPause(err: unknown): number | null {
  if (!NowTempMailError.is(err)) return null;
  if (err.code !== "rate_limit_exceeded") return null;
  return (err.retryAfter ?? 1) * 1000;
}

function jitter(ms: number): number {
  return Math.round(ms * (1 - JITTER + Math.random() * 2 * JITTER));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw new ConnectionError(
      "connection_error",
      `The wait was aborted${reason instanceof Error ? `: ${reason.message}` : ""}.`,
      { cause: reason },
    );
  }
}
