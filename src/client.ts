/**
 * The public client.
 *
 * Three things happen here that are worth knowing about before you read the
 * code, because none of them are obvious from the method signatures:
 *
 * 1. **Construction refuses to run in a browser.** Not as a lecture — `/v1`
 *    rejects any request carrying an `Origin` header before it reads the key, so
 *    a browser build of this SDK is a published API key that also does not work.
 *    The check is narrow on purpose (see `looksLikeBrowser`).
 * 2. **`baseUrl` must be https**, with an explicit carve-out for localhost so
 *    `wrangler dev` works. An http URL anywhere else puts the bearer token on
 *    the wire in clear text.
 * 3. **`mailboxes.create()` confirms before it resolves.** The mail receiver
 *    drops inbound mail permanently if its KV inbox lookup misses, so a handle
 *    returned before the mailbox is readable hands the caller a race they cannot
 *    see. See `#confirm`.
 */

import {
  BrowserUseRefusedError,
  ConfigError,
  MailboxMayExistError,
  NowTempMailError,
} from "./errors.js";
import { Http, VERSION, sleep } from "./http.js";
import type {
  LowQuotaEvent,
  RequestHookEvent,
  ResolvedClientOptions,
  ResponseHookEvent,
} from "./http.js";
import { Mailbox } from "./mailbox.js";
import type {
  Account,
  CreateMailboxParams,
  Domain,
  MeteringSnapshot,
  ReservationList,
  Subscription,
  WebhookEndpoint,
  WireDomainList,
  WireMailbox,
  WireMailboxCreated,
  WireMailboxDeleted,
  WireMe,
  WireReservationList,
  WireSubscription,
  WireWebhookEndpoint,
  WireWebhookTestQueued,
} from "./types.js";

/** Attempts and spacing for the confirming read after a mailbox is created. */
const CONFIRM_ATTEMPTS = 3;
const CONFIRM_DELAY_MS = 400;

export interface ClientOptions {
  /** Default: `process.env.NTM_API_KEY`. */
  apiKey?: string;
  /** Default `https://nowtempmail.com`. Must be https, except an explicit localhost. */
  baseUrl?: string;
  /** Per request, default 30_000. */
  timeoutMs?: number;
  /** GET/DELETE only, default 2. `POST /v1/mailboxes` is never retried. */
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  userAgentSuffix?: string;
  /**
   * Skip the browser refusal. Only correct in a non-browser runtime that
   * happens to define `document`. It does not make `/v1` callable from a page.
   */
  dangerouslyAllowBrowser?: boolean;
  onRequest?(e: RequestHookEvent): void;
  onResponse?(e: ResponseHookEvent): void;
  /** Fires when `X-Quota-Remaining` drops below `lowQuotaThreshold` (default 5). */
  onLowQuota?(e: LowQuotaEvent): void;
  lowQuotaThreshold?: number;
}

export class NowTempMail {
  readonly #http: Http;

  constructor(options: ClientOptions | string = {}) {
    this.#http = new Http(resolveClientOptions(options));
  }

  /** The transport. Exposed for the CLI and the integrations, not for app code. */
  get http(): Http {
    return this.#http;
  }

  get baseUrl(): string {
    return this.#http.baseUrl;
  }

  /**
   * The most recent metering snapshot. Both members are `null` until the first
   * request completes.
   */
  get metering(): MeteringSnapshot {
    return this.#http.metering;
  }

  /**
   * Plan, limits and live usage for the calling key. Runs in peek mode
   * server-side: polling it does not consume the budget it reports on.
   *
   * Branch on `paywall.enabled` rather than inferring a tier from the key
   * prefix — while it is `false` every account gets the launch capabilities.
   */
  async me(): Promise<Account> {
    const res = await this.#http.request<WireMe>({ method: "GET", path: "/v1/me" });
    return toAccount(res.data);
  }

  readonly domains = {
    /**
     * Domains currently accepting mail. Exactly one is `default: true`. The set
     * rotates, so resolve it at runtime rather than hard-coding a domain.
     */
    list: async (): Promise<Domain[]> => {
      const res = await this.#http.request<WireDomainList>({
        method: "GET",
        path: "/v1/domains",
      });
      return res.data.domains.map((d) => ({ domain: d.domain, default: d.default }));
    },
  };

  readonly mailboxes = {
    /**
     * Create a mailbox, then confirm it is readable before resolving.
     *
     * The confirming `GET` runs up to three times, 400ms apart. If none of them
     * succeeds the handle still resolves, with `confirmed: false` — a working
     * mailbox with a slow read is far better than a thrown error over a mailbox
     * that exists and has already cost quota.
     *
     * **This call is never retried.** It is the only endpoint that consumes
     * daily quota and the API has no idempotency key, so a transport failure
     * throws `MailboxMayExistError` rather than sending a second one.
     */
    create: async (params: CreateMailboxParams = {}): Promise<Mailbox> => {
      const body: Record<string, unknown> = {};
      for (const key of ["address", "domain", "ttlSeconds", "reserve", "webhookUrl"] as const) {
        const value = params[key];
        if (value !== undefined) body[key] = value;
      }

      let created: WireMailboxCreated;
      try {
        const res = await this.#http.request<WireMailboxCreated>({
          method: "POST",
          path: "/v1/mailboxes",
          body,
          retry: false,
        });
        created = res.data;
      } catch (err) {
        // The request went out. Whether it landed is unknowable from here, and
        // guessing wrong costs a mailbox out of a 50/day budget.
        if (NowTempMailError.is(err) && err.code === "connection_error") {
          throw new MailboxMayExistError(err);
        }
        throw err;
      }

      const confirmation = await this.#confirm(created.address);
      return new Mailbox(this.#http, {
        address: created.address,
        domain: created.domain,
        createdAt: new Date(created.createdAt * 1000),
        expiresAt: new Date(created.expiresAt * 1000),
        ttlSeconds: created.ttlSeconds,
        reserved: created.reserved,
        webhookUrl: created.webhookUrl,
        messageCount: confirmation?.messageCount ?? created.messageCount,
        lastMessageAt:
          confirmation && confirmation.lastMessageAt !== null
            ? new Date(confirmation.lastMessageAt * 1000)
            : null,
        confirmed: confirmation !== null,
      });
    },

    /**
     * A handle for an address that already exists, verified with one `GET`.
     *
     * `GET /v1/mailboxes/{address}` is narrower than creation's response, so
     * `ttlSeconds` is derived from `expiresAt - createdAt`, and `reserved` and
     * `webhookUrl` read as `false`/`null` because the API does not report them
     * here. Throws `NotFoundError` if the mailbox is gone, expired, or owned by
     * another key — the API cannot tell those apart on purpose.
     */
    get: async (address: string): Promise<Mailbox> => {
      const normalised = normaliseAddress(address);
      const res = await this.#http.request<WireMailbox>({
        method: "GET",
        path: `/v1/mailboxes/${encodeURIComponent(normalised)}`,
      });
      return new Mailbox(this.#http, {
        address: res.data.address,
        createdAt: new Date(res.data.createdAt * 1000),
        expiresAt: new Date(res.data.expiresAt * 1000),
        messageCount: res.data.messageCount,
        lastMessageAt:
          res.data.lastMessageAt === null ? null : new Date(res.data.lastMessageAt * 1000),
        confirmed: true,
      });
    },

    /**
     * A handle with no network call, for when you already know the mailbox is
     * live — a worker-scoped fixture reusing an address across a test file, say.
     *
     * Nothing about it is verified, so `confirmed` is `false`, `createdAt` reads
     * as the epoch (which makes `waitFor*` consider every message already in the
     * inbox) and `expiresInMs` is `Infinity` until you call `refresh()`.
     */
    attach: (address: string): Mailbox =>
      new Mailbox(this.#http, { address: normaliseAddress(address), confirmed: false }),

    /** Deletes the mailbox and its messages. Quota is not refunded. */
    delete: async (address: string): Promise<{ address: string; deletedMessages: number }> => {
      const normalised = normaliseAddress(address);
      const res = await this.#http.request<WireMailboxDeleted>({
        method: "DELETE",
        path: `/v1/mailboxes/${encodeURIComponent(normalised)}`,
      });
      return { address: res.data.address, deletedMessages: res.data.deletedMessages };
    },
  };

  readonly reservations = {
    /** Addresses this ACCOUNT holds across mailbox expiry, with the plan ceiling. */
    list: async (): Promise<ReservationList> => {
      const res = await this.#http.request<WireReservationList>({
        method: "GET",
        path: "/v1/reservations",
      });
      return {
        reservations: res.data.reservations.map((r) => ({
          id: r.id,
          address: r.address,
          createdAt: new Date(r.createdAt * 1000),
        })),
        limit: res.data.limit,
        used: res.data.used,
      };
    },

    /**
     * Give up the claim on an address. This does **not** delete a live mailbox
     * on it — the mailbox keeps receiving mail until its own expiry.
     */
    release: async (address: string): Promise<void> => {
      await this.#http.request<unknown>({
        method: "DELETE",
        path: `/v1/reservations/${encodeURIComponent(normaliseAddress(address))}`,
      });
    },
  };

  readonly webhooks = {
    /**
     * Queue one synthetic `message.received` delivery. `202` means queued, not
     * delivered — check `webhookEndpoints` on `me()` if it does not arrive.
     *
     * Omit `endpointId` to use the newest endpoint on this key that is not
     * disabled. Not retried: it is a POST.
     */
    test: async (endpointId?: string): Promise<WireWebhookTestQueued> => {
      const res = await this.#http.request<WireWebhookTestQueued>({
        method: "POST",
        path: "/v1/webhooks/test",
        body: endpointId === undefined ? {} : { endpointId },
      });
      return res.data;
    },

    /**
     * Deregister an endpoint. Deliveries stop immediately, including queued
     * ones. Mailboxes that pointed at it keep running.
     */
    delete: async (id: string): Promise<void> => {
      await this.#http.request<unknown>({
        method: "DELETE",
        path: `/v1/webhooks/${encodeURIComponent(id)}`,
      });
    },
  };

  /* ---------------------------------------------------------------------- */

  /**
   * Read the mailbox back until it is visible, or give up.
   *
   * The API can accept a mailbox before that mailbox is guaranteed readable,
   * and mail arriving inside that window is dropped rather than queued — so
   * "created" and "able to receive" are not the same instant. Confirming the
   * read is the only way to close the gap from the client side. Returns the
   * narrow read on success and `null` when every attempt failed; the caller
   * decides what that means.
   */
  async #confirm(address: string): Promise<WireMailbox | null> {
    const path = `/v1/mailboxes/${encodeURIComponent(address)}`;
    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
      try {
        // retry:false — the attempt loop here *is* the retry policy, and a
        // nested one would make the number of requests unpredictable.
        const res = await this.#http.request<WireMailbox>({ method: "GET", path, retry: false });
        return res.data;
      } catch {
        if (attempt < CONFIRM_ATTEMPTS) await sleep(CONFIRM_DELAY_MS);
      }
    }
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Option resolution                                                          */
/* -------------------------------------------------------------------------- */

/** NOT `api.nowtempmail.com` — that hostname is unconfirmed and may not resolve. */
export const DEFAULT_BASE_URL = "https://nowtempmail.com";

export function resolveClientOptions(
  options: ClientOptions | string = {},
): ResolvedClientOptions {
  const opts: ClientOptions = typeof options === "string" ? { apiKey: options } : options;

  if (!opts.dangerouslyAllowBrowser && looksLikeBrowser()) {
    throw new BrowserUseRefusedError();
  }

  const apiKey = (opts.apiKey ?? readEnv("NTM_API_KEY") ?? "").trim();
  if (!apiKey) {
    throw new ConfigError(
      "No API key. Pass `new NowTempMail({ apiKey })` or set NTM_API_KEY in the " +
        "environment. Create a key at https://nowtempmail.com/developers.",
    );
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ConfigError(
      "No global fetch. Node 20 or newer is required, or pass `fetch` explicitly.",
    );
  }

  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`timeoutMs must be a positive number of milliseconds.`);
  }
  const maxRetries = opts.maxRetries ?? 2;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new ConfigError(`maxRetries must be a non-negative integer.`);
  }

  const suffix = opts.userAgentSuffix?.trim();
  const runtime = readNodeVersion();
  const userAgent =
    `nowtempmail-node/${VERSION}` +
    (runtime ? ` node/${runtime}` : "") +
    (suffix ? ` ${sanitiseHeaderValue(suffix)}` : "");

  return {
    apiKey,
    baseUrl: resolveBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL),
    timeoutMs,
    maxRetries,
    fetch: fetchImpl,
    userAgent,
    lowQuotaThreshold: opts.lowQuotaThreshold ?? 5,
    onRequest: opts.onRequest,
    onResponse: opts.onResponse,
    onLowQuota: opts.onLowQuota,
  };
}

/**
 * https everywhere, http only on an explicit loopback host.
 *
 * The carve-out is for `wrangler dev`, and it is deliberately a literal-host
 * check rather than a "is it private" heuristic: `http://internal.corp/` puts a
 * bearer token on a wire somebody else can read.
 */
function resolveBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`baseUrl is not a valid absolute URL: ${JSON.stringify(raw)}`);
  }
  if (url.username || url.password) {
    throw new ConfigError("baseUrl must not embed credentials.");
  }
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigError(
      `baseUrl must use https (got ${url.protocol}//${host}). Plain http is ` +
        `accepted only for localhost and 127.0.0.1, because anything else would ` +
        `send your API key in clear text.`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * A real browser: `document` exists and Node does not.
 *
 * Narrow on purpose. jsdom and happy-dom both define `document` while running
 * under Node, and a test suite that uses one is not a browser — failing there
 * would be a false positive nobody could work around except by disabling the
 * check entirely.
 */
function looksLikeBrowser(): boolean {
  if (typeof document === "undefined") return false;
  return readNodeVersion() === undefined;
}

function readNodeVersion(): string | undefined {
  return (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
}

function readEnv(name: string): string | undefined {
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return process?.env?.[name];
}

/** A header value cannot contain CR, LF or NUL. Callers supply the suffix. */
function sanitiseHeaderValue(value: string): string {
  return value.replace(/[^\t\x20-\x7e]/g, "").slice(0, 128);
}

function normaliseAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) throw new ConfigError("An address is required.");
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/* Wire → public                                                              */
/* -------------------------------------------------------------------------- */

function toAccount(wire: WireMe): Account {
  return {
    keyId: wire.keyId,
    environment: wire.environment,
    paywall: wire.paywall,
    subscription: wire.subscription ? toSubscription(wire.subscription) : null,
    plan: wire.plan,
    usage: {
      requestsThisMinute: wire.usage.requestsThisMinute,
      mailboxesToday: wire.usage.mailboxesToday,
      mailboxesRemainingToday: wire.usage.mailboxesRemainingToday,
      reservedAddressesUsed: wire.usage.reservedAddressesUsed,
      resetsAt: {
        minute: new Date(wire.usage.resetsAt.minute * 1000),
        day: new Date(wire.usage.resetsAt.day * 1000),
      },
    },
    webhookEndpoints: (wire.webhookEndpoints ?? []).map(toWebhookEndpoint),
  };
}

function toSubscription(wire: WireSubscription): Subscription {
  return {
    status: wire.status,
    planId: wire.planId,
    currentPeriodEnd:
      wire.currentPeriodEnd === null ? null : new Date(wire.currentPeriodEnd * 1000),
    cancelAtPeriodEnd: wire.cancelAtPeriodEnd,
  };
}

function toWebhookEndpoint(wire: WireWebhookEndpoint): WebhookEndpoint {
  return {
    id: wire.id,
    url: wire.url,
    status: wire.status,
    consecutiveFailures: wire.consecutiveFailures,
    lastSuccessAt: wire.lastSuccessAt === null ? null : new Date(wire.lastSuccessAt * 1000),
    lastFailureAt: wire.lastFailureAt === null ? null : new Date(wire.lastFailureAt * 1000),
    disabledAt: wire.disabledAt === null ? null : new Date(wire.disabledAt * 1000),
    disabledReason: wire.disabledReason,
  };
}
