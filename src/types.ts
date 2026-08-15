/**
 * Wire and public types for the NowTempMail Developer API.
 *
 * Transcribed from the served OpenAPI document at
 * https://nowtempmail.com/v1/openapi.json, vendored in this repo at
 * spec/openapi.json. `npm run spec:drift` fails if the two diverge, so treat
 * the spec as the source of truth and this file as its transcription. Two
 * layers live here on purpose:
 *
 *   Wire*   — exactly what /v1 returns. Epoch seconds, snake-free, nullable
 *             where the spec says nullable. Never widened, never prettified.
 *   public  — what a caller touches. Epoch seconds become Date, because every
 *             consumer of this SDK would otherwise write the same conversion.
 *
 * Keeping them separate is what makes the wire contract auditable against the
 * spec without reading the client.
 */

/* -------------------------------------------------------------------------- */
/* Problem — RFC 9457                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The stable machine-readable error codes. Branch on these; `detail` is prose
 * and may be reworded at any time.
 */
export const PROBLEM_CODES = [
  "unauthorized",
  "invalid_key",
  "key_revoked",
  "account_suspended",
  "forbidden",
  "origin_not_allowed",
  "plan_upgrade_required",
  "not_found",
  "address_taken",
  "address_reserved",
  "invalid_request",
  "rate_limit_exceeded",
  "quota_exceeded",
  "internal_error",
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** Which request field a 402/422 is complaining about. */
export type ProblemParameter =
  | "address"
  | "domain"
  | "ttlSeconds"
  | "reserve"
  | "webhookUrl"
  | "cursor";

export type PlanId = "free" | "starter" | "scale";

export interface WireProblem {
  type: string;
  code: ProblemCode;
  title: string;
  status: number;
  detail: string;
  requestId: string;
  parameter?: ProblemParameter;
  plan?: PlanId;
  maxTtlSeconds?: number;
  endpointId?: string;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Account — GET /v1/me                                                       */
/* -------------------------------------------------------------------------- */

export interface WirePlan {
  id: PlanId;
  label: string;
  requestsPerMinute: number;
  mailboxesPerDay: number;
  maxTtlSeconds: number;
  customAddress: boolean;
  reservedAddresses: number;
  webhooks: boolean;
}

export interface WireUsage {
  requestsThisMinute: number;
  mailboxesToday: number;
  mailboxesRemainingToday: number;
  reservedAddressesUsed: number;
  resetsAt: { minute: number; day: number };
}

export type SubscriptionStatus =
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "PAUSED"
  | "CANCELLED"
  | "EXPIRED";

export interface WireSubscription {
  status: SubscriptionStatus;
  planId: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export type WebhookEndpointStatus = "active" | "disabled";

export interface WireWebhookEndpoint {
  id: string;
  url: string;
  status: WebhookEndpointStatus;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  disabledAt: number | null;
  disabledReason: string | null;
}

export interface WireMe {
  keyId: string;
  environment: "live" | "test";
  paywall: { enabled: boolean; note?: string };
  subscription?: WireSubscription | null;
  plan: WirePlan;
  usage: WireUsage;
  webhookEndpoints: WireWebhookEndpoint[];
}

/** Public shape of GET /v1/me. Epoch fields are Dates. */
export interface Account {
  keyId: string;
  environment: "live" | "test";
  /**
   * Whether paid plans are being sold yet. Branch on this rather than inferring
   * a tier from the key prefix — while it is `false` every account receives the
   * launch plan's capabilities regardless of what it pays.
   */
  paywall: { enabled: boolean; note?: string };
  subscription: Subscription | null;
  plan: WirePlan;
  usage: {
    requestsThisMinute: number;
    mailboxesToday: number;
    mailboxesRemainingToday: number;
    reservedAddressesUsed: number;
    resetsAt: { minute: Date; day: Date };
  };
  webhookEndpoints: WebhookEndpoint[];
}

export interface Subscription {
  status: SubscriptionStatus;
  planId: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  status: WebhookEndpointStatus;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
}

/* -------------------------------------------------------------------------- */
/* Domains — GET /v1/domains                                                  */
/* -------------------------------------------------------------------------- */

export interface WireDomain {
  domain: string;
  default: boolean;
}

export interface WireDomainList {
  domains: WireDomain[];
}

export interface Domain {
  domain: string;
  /**
   * True for the single domain POST /v1/mailboxes will currently choose. Which
   * domain that is changes as the rotation logic weighs domain health.
   */
  default: boolean;
}

/* -------------------------------------------------------------------------- */
/* Mailboxes                                                                  */
/* -------------------------------------------------------------------------- */

export interface CreateMailboxParams {
  /**
   * A bare local part (`my-signup-test`) or a full address — everything from
   * the first `@` on is discarded. Requires `plan.customAddress`.
   *
   * 3-64 chars, `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`, no `..`, not reserved.
   */
  address?: string | null;
  /** Must be active per GET /v1/domains. Never plan-gated. */
  domain?: string | null;
  /**
   * Mailbox lifetime. Minimum 300; maximum is `plan.maxTtlSeconds`. Rejected,
   * never silently clamped. Omit for 86400 (24h) on every plan.
   */
  ttlSeconds?: number | null;
  /**
   * Hold the local part beyond mailbox expiry. Requires `address`. Must be a
   * real boolean — the string "true" is a 422.
   */
  reserve?: boolean | null;
  /** https, port 443/8443, public multi-label DNS name, no credentials. */
  webhookUrl?: string | null;
}

/** POST /v1/mailboxes. The fullest mailbox shape the API ever returns. */
export interface WireMailboxCreated {
  address: string;
  domain: string;
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
  reserved: boolean;
  webhookUrl: string | null;
  messageCount: number;
}

/**
 * GET /v1/mailboxes/{address}. Deliberately narrower than MailboxCreated —
 * `domain`, `ttlSeconds`, `reserved` and `webhookUrl` are not returned here, so
 * a refresh cannot repopulate them.
 */
export interface WireMailbox {
  address: string;
  createdAt: number;
  expiresAt: number;
  messageCount: number;
  lastMessageAt: number | null;
}

export interface WireMailboxDeleted {
  address: string;
  deleted: boolean;
  deletedMessages: number;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

export interface WireMessageSummary {
  id: string;
  /** The raw From header — often `Display Name <addr@host>`, not a bare address. */
  from: string;
  subject: string;
  receivedAt: number;
  attachmentCount: number;
  /** Extracted server-side on ingest. This is why no regex is needed. */
  verificationCodes: string[];
}

export interface WireMessageList {
  messages: WireMessageSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface WireAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface WireMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: number;
  text: string | null;
  html: string | null;
  verificationCodes: string[];
  attachments: WireAttachment[];
}

export interface WireAttachmentList {
  attachments: WireAttachment[];
}

export interface WireMessageDeleted {
  id: string;
  deleted: boolean;
}

/** A message summary, as handed to callers. */
export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  attachmentCount: number;
  verificationCodes: string[];
}

export interface MessagePage {
  messages: MessageSummary[];
  hasMore: boolean;
  /** Opaque. Its encoding is not part of the contract. */
  nextCursor: string | null;
}

/* -------------------------------------------------------------------------- */
/* Reservations                                                               */
/* -------------------------------------------------------------------------- */

export interface WireReservation {
  id: string;
  address: string;
  createdAt: number;
}

export interface WireReservationList {
  reservations: WireReservation[];
  limit: number;
  used: number;
}

export interface Reservation {
  id: string;
  address: string;
  createdAt: Date;
}

export interface ReservationList {
  reservations: Reservation[];
  limit: number;
  used: number;
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

export interface WireWebhookTestQueued {
  queued: boolean;
  endpointId: string;
  url: string;
  messageId: string;
  note?: string;
}

export interface WireWebhookEndpointDeleted {
  id: string;
  deleted: boolean;
}

/**
 * The body we POST to a registered webhookUrl. A pointer, never the mail.
 *
 * MIND THE UNITS. This payload mixes them, and it is not a typo in this file:
 * upstream emits `createdAt` in Unix **seconds** but `data.receivedAt` in Unix
 * **milliseconds**, confirmed against live deliveries. Meanwhile every
 * `receivedAt` on the /v1 message routes is in seconds. Converting both with
 * the same multiplier puts one of them in the year 58347.
 *
 * The SDK normalises all three to `Date` so no caller has to know this.
 */
export interface WireWebhookEvent {
  id: string;
  type: "message.received";
  /** Unix **seconds**. The same `t` that is inside the signature. */
  createdAt: number;
  /** Present only on a synthetic delivery from POST /v1/webhooks/test. */
  deliberate?: boolean;
  data: {
    messageId: string;
    address: string;
    /** Unix **milliseconds** — unlike every other receivedAt in this file. */
    receivedAt: number;
  };
}

export interface WebhookEvent {
  /** Equals the X-NTM-Delivery header. Stable across every retry — dedupe on it. */
  id: string;
  type: "message.received";
  createdAt: Date;
  data: {
    messageId: string;
    address: string;
    receivedAt: Date;
  };
}

/* -------------------------------------------------------------------------- */
/* Metering                                                                   */
/* -------------------------------------------------------------------------- */

/** Read off X-RateLimit-* / X-Quota-* on every response that reached a handler. */
export interface MeteringSnapshot {
  rateLimit: { limit: number; remaining: number; reset: Date } | null;
  quota: { limit: number; remaining: number; reset: Date } | null;
}
