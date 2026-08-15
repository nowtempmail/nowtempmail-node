/**
 * A webhook receiver: verify the signature, ack, then fetch the message.
 *
 *   npm i express
 *   export NTM_API_KEY="ntm_live_..."
 *   export NTM_WEBHOOK_SECRET="whsec_..."     # from /developers/keys, not from /v1
 *   npx tsx examples/webhook-receiver.ts
 *
 * Register the endpoint by passing `webhookUrl` when you create a mailbox —
 * there is no separate "create webhook" call. Same URL on the same key reuses
 * one endpoint with one health record, so a hundred mailboxes can share it.
 *
 * Three things this example is careful about, all of which are easy to get wrong:
 *
 *  1. express.raw(), not express.json(). The digest is over the exact bytes we
 *     sent. A round trip through your JSON library can change escaping and will
 *     break verification for reasons that look like a signing bug.
 *  2. Ack first, work after. The delivery timeout is 10 seconds, hard, and 20
 *     consecutive failed attempts auto-disables the endpoint. An endpoint that
 *     does the work inline walks itself to disabled.
 *  3. Dedupe on event.id. Delivery is at-least-once and event.id (which equals
 *     the X-NTM-Delivery header) is stable across every retry of one message.
 *
 * `nowtempmail/webhooks` uses crypto.subtle and imports nothing from the client,
 * so the verify half of this file also runs unchanged on Cloudflare Workers,
 * Deno and Bun.
 *
 * One units trap, visible only if you read the raw JSON instead of the parsed
 * event: on the wire `createdAt` is Unix SECONDS (the same `t` that is inside
 * the signature) while `data.receivedAt` is Unix MILLISECONDS. The SDK
 * normalises both to Date, which is one reason to use it rather than hand-rolling.
 */

import express from "express";
import { NowTempMail } from "nowtempmail";
// NowTempMailError comes from the webhooks subpath too, so a verify-only
// receiver — a Worker, say — never has to import the client at all.
import { NowTempMailError, verifyWebhook, type WebhookEvent } from "nowtempmail/webhooks";

const SECRET = process.env.NTM_WEBHOOK_SECRET;
if (!SECRET) throw new Error("NTM_WEBHOOK_SECRET is required");

const ntm = new NowTempMail();
const app = express();

/** Replace with Redis, a queue, or a table. An in-memory Set is not a dedupe store. */
const handled = new Set<string>();

app.post(
  "/hooks/nowtempmail",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event: WebhookEvent;
    try {
      event = await verifyWebhook({
        rawBody: req.body as Buffer,
        signature: req.get("X-NTM-Signature"),
        secret: SECRET,
        toleranceSeconds: 300,
      });
    } catch (err) {
      // webhook_config means YOUR configuration is broken (blank secret, say) and
      // every delivery will fail until you fix it. webhook_signature means this
      // particular request did not verify. Log them differently.
      if (NowTempMailError.is(err)) {
        console.error(`rejected: ${err.toLogString()} — ${err.message}`);
      } else {
        console.error("rejected:", err);
      }
      res.sendStatus(400);
      return;
    }

    if (handled.has(event.id)) {
      res.sendStatus(200);
      return;
    }
    handled.add(event.id);

    // Ack inside the 10s budget, then do the work off the request.
    res.sendStatus(200);

    // A test delivery from ntm.webhooks.test() is a normal message.received
    // event with no message behind it. Fetching it returns 404.
    if (event.data.messageId.startsWith("test_")) {
      console.log(`test delivery ${event.id} verified — your verifier works`);
      return;
    }

    void handleMessage(event).catch((err: unknown) => {
      console.error(NowTempMailError.is(err) ? err.toLogString() : err);
    });
  },
);

/**
 * The payload is a pointer, not the mail: messageId, address, receivedAt and
 * nothing else. No subject, no sender, no body, no codes. Reading the message
 * needs the API key, which never crosses your callback URL — so fetch it here.
 */
async function handleMessage(event: WebhookEvent): Promise<void> {
  // attach() builds a handle with no network call. We already know the mailbox
  // is live, because mail just landed in it.
  const inbox = ntm.mailboxes.attach(event.data.address);
  const message = await inbox.messages.get(event.data.messageId);

  console.log(
    `${event.data.address} <- ${message.from}: ${message.subject}` +
      (message.code ? ` [code ${message.code}]` : ""),
  );
}

const server = app.listen(3000, () => {
  console.log("listening on :3000");
  console.log("register it with:");
  console.log(
    '  await ntm.mailboxes.create({ webhookUrl: "https://your.public.host/hooks/nowtempmail" })',
  );
  console.log("then prove the verifier works, without waiting for real mail:");
  console.log("  await ntm.webhooks.test()");
});

process.on("SIGINT", () => {
  // Endpoint health, including disabledReason, lives on ntm.me() under
  // webhookEndpoints. It is the only place the auto-disable decision is visible.
  ntm
    .me()
    .then((account) => {
      for (const endpoint of account.webhookEndpoints) {
        console.log(
          `${endpoint.url} ${endpoint.status} failures=${endpoint.consecutiveFailures}` +
            (endpoint.disabledReason ? ` reason=${endpoint.disabledReason}` : ""),
        );
      }
    })
    .finally(() => server.close());
});
