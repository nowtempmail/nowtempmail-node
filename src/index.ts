/**
 * `nowtempmail` — disposable mailboxes and OTP codes for your tests.
 *
 * ```ts
 * import { NowTempMail } from "nowtempmail";
 *
 * const ntm = new NowTempMail();                 // reads NTM_API_KEY
 * const inbox = await ntm.mailboxes.create();    // resolves once it can receive
 * await signUp(inbox.address);
 * const code = await inbox.waitForCode();        // extracted server-side
 * ```
 *
 * Server-side only. `/v1` rejects any request carrying an `Origin` header, and
 * constructing the client in a browser throws `BrowserUseRefusedError`.
 *
 * Subpath entry points, kept out of this module so a plain install never loads
 * an optional peer: `nowtempmail/webhooks`, `nowtempmail/playwright`,
 * `nowtempmail/mcp`.
 */

export { NowTempMail, DEFAULT_BASE_URL } from "./client.js";
export type { ClientOptions } from "./client.js";

export { Mailbox } from "./mailbox.js";
export type { MailboxInit, MessageFilter } from "./mailbox.js";

export { Attachment, Message } from "./message.js";

export { MIN_POLL_INTERVAL_MS, VERSION } from "./http.js";
export type {
  HttpResult,
  LowQuotaEvent,
  RequestHookEvent,
  RequestOptions,
  ResolvedClientOptions,
  ResponseHookEvent,
} from "./http.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Branch on `err.code`, or on `NowTempMailError.is(err)` — never on a bare
 * `instanceof`. This package is dual-published, so a consumer can hold two
 * copies of these classes at once and `instanceof` then quietly returns false.
 */
export {
  AccountSuspendedError,
  AddressReservedError,
  AddressTakenError,
  BrowserUseRefusedError,
  ConfigError,
  ConnectionError,
  ForbiddenError,
  InternalError,
  InvalidKeyError,
  InvalidRequestError,
  KeyRevokedError,
  MailboxMayExistError,
  NotFoundError,
  NowTempMailError,
  OriginNotAllowedError,
  PlanUpgradeRequiredError,
  QuotaExceededError,
  RateLimitExceededError,
  TimeoutError,
  UnauthorizedError,
  WebhookConfigError,
  WebhookSignatureError,
  errorFromProblem,
} from "./errors.js";
export type { AnyErrorCode, ErrorContext, LocalErrorCode } from "./errors.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export { PROBLEM_CODES } from "./types.js";
export type {
  Account,
  CreateMailboxParams,
  Domain,
  MessagePage,
  MessageSummary,
  MeteringSnapshot,
  PlanId,
  ProblemCode,
  ProblemParameter,
  Reservation,
  ReservationList,
  Subscription,
  SubscriptionStatus,
  WebhookEndpoint,
  WebhookEndpointStatus,
  WebhookEvent,
  WireAttachment,
  WireAttachmentList,
  WireDomain,
  WireDomainList,
  WireMailbox,
  WireMailboxCreated,
  WireMailboxDeleted,
  WireMe,
  WireMessage,
  WireMessageDeleted,
  WireMessageList,
  WireMessageSummary,
  WirePlan,
  WireProblem,
  WireReservation,
  WireReservationList,
  WireSubscription,
  WireUsage,
  WireWebhookEndpoint,
  WireWebhookEndpointDeleted,
  WireWebhookEvent,
  WireWebhookTestQueued,
} from "./types.js";

import { NowTempMail as NowTempMailClient } from "./client.js";

export default NowTempMailClient;
