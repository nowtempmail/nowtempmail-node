/**
 * Pure renderers: values in, strings out. No process, no network, no colour
 * decision of their own — a {@link Palette} is always passed in, so the same
 * function produces the coloured and the plain form.
 *
 * Nothing in here can reach the API key. The JSON shapes are hand-built field by
 * field rather than serialised from an object, which is what makes "the secret
 * cannot appear under --json" a property of the code and not of a promise.
 */

import type { Mailbox } from "../mailbox.js";
import type { Account, Domain, MessageSummary, MeteringSnapshot } from "../types.js";
import {
  formatClock,
  formatDuration,
  plural,
  renderTable,
  sanitiseForTerminal,
  truncate,
  type Palette,
} from "./style.js";

/* -------------------------------------------------------------------------- */
/* JSON shapes                                                                */
/* -------------------------------------------------------------------------- */

export function mailboxJson(mailbox: Mailbox): Record<string, unknown> {
  return {
    address: mailbox.address,
    localPart: mailbox.localPart,
    domain: mailbox.domain,
    createdAt: mailbox.createdAt.toISOString(),
    expiresAt: mailbox.expiresAt.toISOString(),
    ttlSeconds: mailbox.ttlSeconds,
    reserved: mailbox.reserved,
    webhookUrl: mailbox.webhookUrl,
    messageCount: mailbox.messageCount,
    confirmed: mailbox.confirmed,
  };
}

export function messageJson(message: MessageSummary): Record<string, unknown> {
  return {
    id: message.id,
    from: message.from,
    subject: message.subject,
    receivedAt: message.receivedAt.toISOString(),
    attachmentCount: message.attachmentCount,
    verificationCodes: [...message.verificationCodes],
  };
}

/**
 * `whoami` as JSON. Assembled field by field: `keyId` is the public short
 * identifier and there is no field here that could hold the secret.
 */
export function accountJson(account: Account): Record<string, unknown> {
  return {
    keyId: account.keyId,
    environment: account.environment,
    paywall: { enabled: account.paywall.enabled, note: account.paywall.note ?? null },
    plan: {
      id: account.plan.id,
      label: account.plan.label,
      requestsPerMinute: account.plan.requestsPerMinute,
      mailboxesPerDay: account.plan.mailboxesPerDay,
      maxTtlSeconds: account.plan.maxTtlSeconds,
      customAddress: account.plan.customAddress,
      reservedAddresses: account.plan.reservedAddresses,
      webhooks: account.plan.webhooks,
    },
    usage: {
      requestsThisMinute: account.usage.requestsThisMinute,
      mailboxesToday: account.usage.mailboxesToday,
      mailboxesRemainingToday: account.usage.mailboxesRemainingToday,
      reservedAddressesUsed: account.usage.reservedAddressesUsed,
      resetsAt: {
        minute: account.usage.resetsAt.minute.toISOString(),
        day: account.usage.resetsAt.day.toISOString(),
      },
    },
    subscription: account.subscription
      ? {
          status: account.subscription.status,
          planId: account.subscription.planId,
          currentPeriodEnd: account.subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: account.subscription.cancelAtPeriodEnd,
        }
      : null,
    webhookEndpoints: account.webhookEndpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      status: endpoint.status,
      consecutiveFailures: endpoint.consecutiveFailures,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Human output                                                               */
/* -------------------------------------------------------------------------- */

/** `expires in 24h · 37 mailboxes left today` — the stderr half of `new`. */
export function createdStatusLine(
  mailbox: Mailbox,
  metering: MeteringSnapshot | null | undefined,
): string {
  const parts = [`expires in ${formatDuration(mailbox.expiresInMs)}`];
  const remaining = metering?.quota?.remaining;
  if (typeof remaining === "number") {
    parts.push(`${remaining} ${plural(remaining, "mailbox", "mailboxes")} left today`);
  }
  return parts.join(" · ");
}

/**
 * One inbox event, as `tail` prints it. Sender and subject came from a stranger,
 * so both are sanitised and truncated before they reach the terminal.
 */
export function messageLine(message: MessageSummary, palette: Palette): string {
  const when = palette.dim(formatClock(message.receivedAt));
  const from = truncate(sanitiseForTerminal(message.from), 34);
  const subject = truncate(sanitiseForTerminal(message.subject), 48);
  const code = message.verificationCodes[0];
  const tail = code ? `  ${palette.green(`code ${code}`)}` : "";
  const clip =
    message.attachmentCount > 0
      ? `  ${palette.dim(`${message.attachmentCount} ${plural(message.attachmentCount, "attachment")}`)}`
      : "";
  return `${when}  ${from}  ${subject}${tail}${clip}\n`;
}

/** `ls` output: newest first, one row per message. */
export function messagesTable(messages: readonly MessageSummary[], palette: Palette): string {
  const rows = messages.map((message) => [
    formatClock(message.receivedAt),
    truncate(sanitiseForTerminal(message.from), 34),
    truncate(sanitiseForTerminal(message.subject), 48),
    message.verificationCodes[0] ?? "",
    message.attachmentCount > 0 ? String(message.attachmentCount) : "",
  ]);
  return renderTable(["RECEIVED", "FROM", "SUBJECT", "CODE", "ATT"], rows, palette);
}

/**
 * `whoami`. Prints `keyId`, which is the public identifier printed next to a key
 * in the dashboard — never the secret, which this function is not given.
 */
export function accountBlock(account: Account, palette: Palette): string {
  const label = (text: string) => palette.dim(text.padEnd(11));
  const usage = account.usage;
  const plan = account.plan;
  const lines: string[] = [
    `${label("key")}${account.keyId} ${palette.dim(`(${account.environment})`)}`,
    `${label("plan")}${plan.label}${
      account.paywall.enabled ? "" : palette.dim("  launch pricing: every capability is enabled")
    }`,
    `${label("requests")}${usage.requestsThisMinute} / ${plan.requestsPerMinute} this minute ${palette.dim(
      `· resets in ${formatDuration(usage.resetsAt.minute.getTime() - Date.now())}`,
    )}`,
    `${label("mailboxes")}${usage.mailboxesToday} / ${plan.mailboxesPerDay} today ${palette.dim(
      `· ${usage.mailboxesRemainingToday} left · resets in ${formatDuration(
        usage.resetsAt.day.getTime() - Date.now(),
      )}`,
    )}`,
    `${label("max ttl")}${formatDuration(plan.maxTtlSeconds * 1000)}`,
    `${label("reserved")}${usage.reservedAddressesUsed} / ${plan.reservedAddresses}`,
  ];

  if (account.webhookEndpoints.length === 0) {
    lines.push(`${label("webhooks")}${palette.dim("none registered")}`);
  } else {
    for (const [i, endpoint] of account.webhookEndpoints.entries()) {
      const status =
        endpoint.status === "active" ? palette.green("active") : palette.amber("disabled");
      lines.push(`${label(i === 0 ? "webhooks" : "")}${endpoint.url} ${status}`);
    }
  }

  if (account.subscription) {
    lines.push(`${label("billing")}${account.subscription.planId} ${account.subscription.status}`);
  }

  return `${lines.join("\n")}\n`;
}

/** `domains`, with the one the rotation would currently pick marked. */
export function domainLines(domains: readonly Domain[], palette: Palette): string {
  const width = Math.max(0, ...domains.map((d) => d.domain.length));
  return domains
    .map((d) => `${d.domain.padEnd(d.default ? width : 0)}${d.default ? palette.dim("  (default)") : ""}`)
    .map((line) => `${line.replace(/\s+$/, "")}\n`)
    .join("");
}
