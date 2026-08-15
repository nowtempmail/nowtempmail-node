/**
 * An in-memory /v1 implementation, shared by every workstream's tests.
 *
 * Two ways to use it:
 *
 *   createMockApi()        → { fetch, deliver, state, requests }
 *                            Pass `fetch` straight into ClientOptions.
 *   startMockServer(api)   → { url, close }
 *                            A real listening socket, for driving the CLI as a
 *                            subprocess.
 *
 * It is deliberately faithful about the things the SDK's design depends on:
 * metering headers on every response, RFC 9457 problem bodies with a requestId,
 * a Retry-After on 429, plan gates on the four paid parameters, cursor
 * pagination, and quota that is consumed by mailbox creation and *never*
 * refunded by deletion.
 */

import { createServer } from "node:http";
import type {
  WireAttachment,
  WireMessage,
  WireMessageSummary,
  WirePlan,
  WireProblem,
  ProblemCode,
  ProblemParameter,
} from "../../src/types.js";

export const MOCK_KEY = "ntm_live_k7Rm2xQp9Ldv_4nT8wKmZqRv2sYbXdF6hJ3pLcN9gTuA";

const FREE_PLAN: WirePlan = {
  id: "free",
  label: "Free",
  requestsPerMinute: 30,
  mailboxesPerDay: 50,
  maxTtlSeconds: 86_400,
  customAddress: false,
  reservedAddresses: 0,
  webhooks: false,
};

export interface MockMailbox {
  address: string;
  domain: string;
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
  reserved: boolean;
  webhookUrl: string | null;
}

interface StoredMessage extends WireMessageSummary {
  to: string;
  text: string | null;
  html: string | null;
  attachments: WireAttachment[];
  attachmentBytes: Record<string, Uint8Array>;
}

export interface MockApiOptions {
  plan?: Partial<WirePlan>;
  apiKey?: string;
  /**
   * Clock in epoch ms. Defaults to the real clock.
   *
   * It used to default to a fixed instant, which was a trap: that instant went
   * into the past, so every mailbox the mock minted with the default 24h TTL was
   * born already expired and any `expired` / `expiresInMs` assertion failed for
   * reasons that had nothing to do with the code under test. Pass a fixed clock
   * explicitly when a test needs determinism.
   */
  now?: () => number;
  /** Force the next N requests to fail with this code, then behave normally. */
  failNext?: { count: number; code: ProblemCode };
  /** Make POST /v1/mailboxes reject the confirming GET this many times. */
  confirmMisses?: number;
}

export interface MockApi {
  fetch: typeof globalThis.fetch;
  handle(request: Request): Promise<Response>;
  /** Simulate inbound mail landing in a mailbox. */
  deliver(
    address: string,
    msg?: Partial<
      Pick<WireMessageSummary, "from" | "subject" | "verificationCodes">
    > & {
      text?: string;
      html?: string;
      attachments?: Array<{ filename: string; contentType: string; bytes: Uint8Array }>;
      receivedAt?: number;
    },
  ): StoredMessage;
  state: {
    plan: WirePlan;
    mailboxes: Map<string, MockMailbox>;
    messages: Map<string, StoredMessage[]>;
    mailboxesToday: number;
    requestsThisMinute: number;
    reservations: Array<{ id: string; address: string; createdAt: number }>;
    webhookEndpoints: Array<{ id: string; url: string; status: "active" | "disabled" }>;
  };
  /** Every request seen, in order. Assert traffic shape against this. */
  requests: Array<{ method: string; path: string; requestId: string | null }>;
  reset(): void;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}${(++seq).toString().padStart(4, "0")}`;

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const apiKey = options.apiKey ?? MOCK_KEY;
  const now = options.now ?? (() => 1_786_097_700_000);
  const plan: WirePlan = { ...FREE_PLAN, ...options.plan };

  const state: MockApi["state"] = {
    plan,
    mailboxes: new Map(),
    messages: new Map(),
    mailboxesToday: 0,
    requestsThisMinute: 0,
    reservations: [],
    webhookEndpoints: [],
  };

  const requests: MockApi["requests"] = [];
  let failNext = options.failNext ? { ...options.failNext } : null;
  let confirmMisses = options.confirmMisses ?? 0;

  const sec = () => Math.floor(now() / 1000);

  function metering(): Record<string, string> {
    return {
      "X-RateLimit-Limit": String(plan.requestsPerMinute),
      "X-RateLimit-Remaining": String(
        Math.max(0, plan.requestsPerMinute - state.requestsThisMinute),
      ),
      "X-RateLimit-Reset": String(sec() + 60),
      "X-Quota-Limit": String(plan.mailboxesPerDay),
      "X-Quota-Remaining": String(Math.max(0, plan.mailboxesPerDay - state.mailboxesToday)),
      "X-Quota-Reset": String(sec() + 3600),
    };
  }

  function problem(
    code: ProblemCode,
    status: number,
    detail: string,
    requestId: string,
    extra: Partial<WireProblem> = {},
  ): Response {
    const body: WireProblem = {
      type: `https://nowtempmail.com/developers/errors#${code}`,
      code,
      title: code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      status,
      detail,
      requestId,
      ...extra,
    };
    const headers: Record<string, string> = {
      ...metering(),
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
    };
    if (status === 429) headers["Retry-After"] = "2";
    else headers["X-Request-Id"] = requestId;
    return new Response(JSON.stringify(body), { status, headers });
  }

  function ok(data: unknown, requestId: string, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        ...metering(),
        "X-Request-Id": requestId,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  function deliver(
    address: string,
    msg: Parameters<MockApi["deliver"]>[1] = {},
  ): StoredMessage {
    const attachments: WireAttachment[] = [];
    const attachmentBytes: Record<string, Uint8Array> = {};
    for (const a of msg.attachments ?? []) {
      const id = nextId("att_");
      attachments.push({
        id,
        filename: a.filename,
        contentType: a.contentType,
        size: a.bytes.byteLength,
      });
      attachmentBytes[id] = a.bytes;
    }
    const stored: StoredMessage = {
      id: nextId("msg_"),
      from: msg.from ?? "GitHub <noreply@github.com>",
      subject: msg.subject ?? "[GitHub] Please verify your device",
      receivedAt: msg.receivedAt ?? sec(),
      attachmentCount: attachments.length,
      verificationCodes: msg.verificationCodes ?? ["482913"],
      to: address,
      text: msg.text ?? "Your code is 482913. Visit https://github.com/verify to finish.",
      html: msg.html ?? null,
      attachments,
      attachmentBytes,
    };
    const list = state.messages.get(address) ?? [];
    // Newest first, matching the API's ordering.
    list.unshift(stored);
    state.messages.set(address, list);
    return stored;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const requestId = request.headers.get("X-Request-Id") ?? `req_mock${++seq}`;
    requests.push({ method: request.method, path, requestId });

    // The origin guard runs before auth, exactly as /v1 does.
    if (request.headers.get("Origin")) {
      return problem("origin_not_allowed", 403, "This API cannot be called from a browser.", requestId);
    }
    if (request.method === "OPTIONS") {
      return problem("origin_not_allowed", 403, "There is nothing to preflight.", requestId);
    }

    if (path === "/v1/openapi.json") {
      return new Response(JSON.stringify({ openapi: "3.1.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      });
    }

    const auth = request.headers.get("Authorization");
    if (!auth) return problem("unauthorized", 401, "No credential presented.", requestId);
    if (auth !== `Bearer ${apiKey}`) {
      return problem("invalid_key", 401, "The key was not recognised.", requestId);
    }

    if (failNext && failNext.count > 0) {
      failNext.count--;
      const code = failNext.code;
      const status =
        code === "rate_limit_exceeded" || code === "quota_exceeded"
          ? 429
          : code === "internal_error"
            ? 500
            : 400;
      return problem(code, status, `Injected ${code}.`, requestId);
    }

    const isPeek = path === "/v1/me";
    if (!isPeek) state.requestsThisMinute++;

    /* ---- account ---- */
    if (path === "/v1/me" && request.method === "GET") {
      return ok(
        {
          keyId: "k7Rm2xQp9Ldv",
          environment: "live",
          paywall: { enabled: false, note: "Launch pricing: every capability is enabled." },
          subscription: null,
          plan,
          usage: {
            requestsThisMinute: state.requestsThisMinute,
            mailboxesToday: state.mailboxesToday,
            mailboxesRemainingToday: Math.max(0, plan.mailboxesPerDay - state.mailboxesToday),
            reservedAddressesUsed: state.reservations.length,
            resetsAt: { minute: sec() + 60, day: sec() + 3600 },
          },
          webhookEndpoints: state.webhookEndpoints.map((e) => ({
            ...e,
            consecutiveFailures: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            disabledAt: null,
            disabledReason: null,
          })),
        },
        requestId,
      );
    }

    if (path === "/v1/domains" && request.method === "GET") {
      return ok(
        { domains: [{ domain: "allogebra.com", default: true }, { domain: "mailtemp.dev", default: false }] },
        requestId,
      );
    }

    /* ---- mailboxes ---- */
    if (path === "/v1/mailboxes" && request.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
        if (body === null || typeof body !== "object") body = {};
      } catch {
        body = {};
      }

      if (state.mailboxesToday >= plan.mailboxesPerDay) {
        return problem("quota_exceeded", 429, "Daily mailbox quota reached.", requestId, { plan: plan.id });
      }

      const gate = (parameter: ProblemParameter, detail: string) =>
        problem("plan_upgrade_required", 402, detail, requestId, {
          parameter,
          plan: plan.id,
          maxTtlSeconds: plan.maxTtlSeconds,
        });

      // Validation order is fixed: domain, ttlSeconds, webhookUrl, address.
      let domain = "allogebra.com";
      if (body.domain !== undefined && body.domain !== null) {
        if (typeof body.domain !== "string") {
          return problem("invalid_request", 422, "`domain` must be a string.", requestId, { parameter: "domain" });
        }
        const d = body.domain.trim().toLowerCase();
        if (!["allogebra.com", "mailtemp.dev"].includes(d)) {
          return problem("invalid_request", 422, "`domain` is not active.", requestId, { parameter: "domain" });
        }
        domain = d;
      }

      let ttlSeconds = 86_400;
      if (body.ttlSeconds !== undefined && body.ttlSeconds !== null) {
        if (typeof body.ttlSeconds !== "number") {
          return problem("invalid_request", 422, "`ttlSeconds` must be a number.", requestId, {
            parameter: "ttlSeconds",
          });
        }
        // Documented asymmetry: any numeric failure is 402, even a malformed one.
        if (!Number.isInteger(body.ttlSeconds) || body.ttlSeconds < 300 || body.ttlSeconds > plan.maxTtlSeconds) {
          return gate("ttlSeconds", `\`ttlSeconds\` must be between 300 and ${plan.maxTtlSeconds}.`);
        }
        ttlSeconds = body.ttlSeconds;
      }

      if (body.webhookUrl !== undefined && body.webhookUrl !== null) {
        if (!plan.webhooks) return gate("webhookUrl", "Inbound webhooks require a paid plan.");
        if (typeof body.webhookUrl !== "string" || !body.webhookUrl.startsWith("https://")) {
          return problem("invalid_request", 422, "`webhookUrl` must be https.", requestId, {
            parameter: "webhookUrl",
          });
        }
      }

      let localPart = `crystal${400 + state.mailboxesToday}`;
      if (body.address !== undefined && body.address !== null) {
        if (!plan.customAddress) return gate("address", "Custom addresses require a paid plan.");
        if (typeof body.address !== "string") {
          return problem("invalid_request", 422, "`address` must be a string.", requestId, { parameter: "address" });
        }
        const raw = body.address.split("@")[0]!.trim().toLowerCase();
        if (["admin", "support", "postmaster", "abuse", "otp", "api"].includes(raw.replace(/[._-]/g, ""))) {
          return problem("invalid_request", 422, `\`${raw}\` is reserved and cannot be registered.`, requestId, {
            parameter: "address",
          });
        }
        if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(raw) || raw.length < 3 || raw.length > 64) {
          return problem("invalid_request", 422, "`address` is malformed.", requestId, { parameter: "address" });
        }
        localPart = raw;
      }

      if (body.reserve !== undefined && body.reserve !== null) {
        if (typeof body.reserve !== "boolean") {
          return problem("invalid_request", 422, "`reserve` must be a boolean.", requestId, { parameter: "reserve" });
        }
        if (body.reserve && (body.address === undefined || body.address === null)) {
          return problem("invalid_request", 422, "`reserve` requires `address`.", requestId, { parameter: "reserve" });
        }
        if (body.reserve && state.reservations.length >= plan.reservedAddresses) {
          return gate("reserve", `You already hold ${state.reservations.length} reserved addresses.`);
        }
      }

      const address = `${localPart}@${domain}`;
      if (state.mailboxes.has(address)) {
        return problem("address_taken", 409, `\`${address}\` is not available.`, requestId);
      }

      const createdAt = sec();
      const mailbox: MockMailbox = {
        address,
        domain,
        createdAt,
        expiresAt: createdAt + ttlSeconds,
        ttlSeconds,
        reserved: body.reserve === true,
        webhookUrl: typeof body.webhookUrl === "string" ? body.webhookUrl : null,
      };
      state.mailboxes.set(address, mailbox);
      state.messages.set(address, []);
      // Consumed on creation, and never given back — deletion does not refund.
      state.mailboxesToday++;
      if (mailbox.reserved) {
        state.reservations.push({ id: nextId("rsv_"), address, createdAt });
      }
      if (mailbox.webhookUrl) {
        state.webhookEndpoints.push({ id: nextId("whe_"), url: mailbox.webhookUrl, status: "active" });
      }

      return ok({ ...mailbox, messageCount: 0 }, requestId, 201);
    }

    const mailboxMatch = /^\/v1\/mailboxes\/([^/]+)$/.exec(path);
    if (mailboxMatch) {
      const address = decodeURIComponent(mailboxMatch[1]!).toLowerCase();
      const mailbox = state.mailboxes.get(address);
      if (request.method === "GET") {
        // Simulate KV propagation lag on the confirming read.
        if (confirmMisses > 0) {
          confirmMisses--;
          return problem("not_found", 404, "No such mailbox.", requestId);
        }
        if (!mailbox) return problem("not_found", 404, "No such mailbox.", requestId);
        const msgs = state.messages.get(address) ?? [];
        return ok(
          {
            address: mailbox.address,
            createdAt: mailbox.createdAt,
            expiresAt: mailbox.expiresAt,
            messageCount: msgs.length,
            lastMessageAt: msgs[0]?.receivedAt ?? null,
          },
          requestId,
        );
      }
      if (request.method === "DELETE") {
        if (!mailbox) return problem("not_found", 404, "No such mailbox.", requestId);
        const deletedMessages = (state.messages.get(address) ?? []).length;
        state.mailboxes.delete(address);
        state.messages.delete(address);
        return ok({ address, deleted: true, deletedMessages }, requestId);
      }
    }

    /* ---- messages ---- */
    const listMatch = /^\/v1\/mailboxes\/([^/]+)\/messages$/.exec(path);
    if (listMatch && request.method === "GET") {
      const address = decodeURIComponent(listMatch[1]!).toLowerCase();
      if (!state.mailboxes.has(address)) return problem("not_found", 404, "No such mailbox.", requestId);
      const all = state.messages.get(address) ?? [];

      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? 25 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return problem("invalid_request", 422, "`limit` must be 1-100.", requestId);
      }

      let start = 0;
      const cursor = url.searchParams.get("cursor");
      if (cursor) {
        let decoded: string;
        try {
          decoded = Buffer.from(cursor, "base64").toString("utf8");
        } catch {
          return problem("invalid_request", 422, "The `cursor` parameter is not valid.", requestId, {
            parameter: "cursor",
          });
        }
        const id = decoded.split(":")[1];
        if (!id) {
          return problem("invalid_request", 422, "The `cursor` parameter is not valid.", requestId, {
            parameter: "cursor",
          });
        }
        const idx = all.findIndex((m) => m.id === id);
        // A cursor naming a deleted message resolves to the end of the list.
        start = idx === -1 ? all.length : idx + 1;
      }

      const page = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      const last = page[page.length - 1];
      return ok(
        {
          messages: page.map((m) => ({
            id: m.id,
            from: m.from,
            subject: m.subject,
            receivedAt: m.receivedAt,
            attachmentCount: m.attachmentCount,
            verificationCodes: m.verificationCodes,
          })),
          hasMore,
          nextCursor:
            hasMore && last ? Buffer.from(`${last.receivedAt}000:${last.id}`).toString("base64") : null,
        },
        requestId,
      );
    }

    const msgMatch = /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)$/.exec(path);
    if (msgMatch) {
      const address = decodeURIComponent(msgMatch[1]!).toLowerCase();
      const id = decodeURIComponent(msgMatch[2]!);
      const all = state.messages.get(address);
      if (!all) return problem("not_found", 404, "No such mailbox.", requestId);
      const idx = all.findIndex((m) => m.id === id);
      if (idx === -1) return problem("not_found", 404, "No such message.", requestId);
      const m = all[idx]!;
      if (request.method === "GET") {
        const full: WireMessage = {
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          receivedAt: m.receivedAt,
          text: m.text,
          html: m.html,
          verificationCodes: m.verificationCodes,
          attachments: m.attachments,
        };
        return ok(full, requestId);
      }
      if (request.method === "DELETE") {
        all.splice(idx, 1);
        return ok({ id, deleted: true }, requestId);
      }
    }

    const attListMatch = /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)\/attachments$/.exec(path);
    if (attListMatch && request.method === "GET") {
      const address = decodeURIComponent(attListMatch[1]!).toLowerCase();
      const id = decodeURIComponent(attListMatch[2]!);
      const m = (state.messages.get(address) ?? []).find((x) => x.id === id);
      if (!m) return problem("not_found", 404, "No such message.", requestId);
      return ok({ attachments: m.attachments }, requestId);
    }

    const attMatch = /^\/v1\/mailboxes\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attMatch && request.method === "GET") {
      const address = decodeURIComponent(attMatch[1]!).toLowerCase();
      const id = decodeURIComponent(attMatch[2]!);
      const attId = decodeURIComponent(attMatch[3]!);
      const m = (state.messages.get(address) ?? []).find((x) => x.id === id);
      const meta = m?.attachments.find((a) => a.id === attId);
      const bytes = m?.attachmentBytes[attId];
      if (!m || !meta || !bytes) return problem("not_found", 404, "No such attachment.", requestId);
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          ...metering(),
          "X-Request-Id": requestId,
          "Content-Type": meta.contentType,
          "Content-Disposition": `attachment; filename="${meta.filename}"`,
        },
      });
    }

    /* ---- reservations ---- */
    if (path === "/v1/reservations" && request.method === "GET") {
      return ok(
        { reservations: state.reservations, limit: plan.reservedAddresses, used: state.reservations.length },
        requestId,
      );
    }
    const rsvMatch = /^\/v1\/reservations\/([^/]+)$/.exec(path);
    if (rsvMatch && request.method === "DELETE") {
      const address = decodeURIComponent(rsvMatch[1]!).toLowerCase();
      const i = state.reservations.findIndex((r) => r.address === address);
      if (i === -1) return problem("not_found", 404, "No such reservation.", requestId);
      state.reservations.splice(i, 1);
      return ok({ address, released: true }, requestId);
    }

    /* ---- webhooks ---- */
    if (path === "/v1/webhooks/test" && request.method === "POST") {
      const endpoint = state.webhookEndpoints[0];
      if (!endpoint) {
        return problem("invalid_request", 422, "No webhook endpoint is registered.", requestId);
      }
      return ok(
        { queued: true, endpointId: endpoint.id, url: endpoint.url, messageId: `test_${nextId("m")}` },
        requestId,
      );
    }
    const wheMatch = /^\/v1\/webhooks\/([^/]+)$/.exec(path);
    if (wheMatch && request.method === "DELETE") {
      const id = decodeURIComponent(wheMatch[1]!);
      const i = state.webhookEndpoints.findIndex((e) => e.id === id);
      if (i === -1) return problem("not_found", 404, "No such endpoint.", requestId);
      state.webhookEndpoints.splice(i, 1);
      return ok({ id, deleted: true }, requestId);
    }

    return problem("not_found", 404, `No route for ${request.method} ${path}.`, requestId);
  }

  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return handle(request);
  };

  return {
    fetch: mockFetch,
    handle,
    deliver,
    state,
    requests,
    reset() {
      state.mailboxes.clear();
      state.messages.clear();
      state.reservations.length = 0;
      state.webhookEndpoints.length = 0;
      state.mailboxesToday = 0;
      state.requestsThisMinute = 0;
      requests.length = 0;
      failNext = options.failNext ? { ...options.failNext } : null;
      confirmMisses = options.confirmMisses ?? 0;
    },
  };
}

/**
 * Bind a MockApi to a real socket. Used to drive the CLI as a subprocess, which
 * is the only way to test its exit codes and stdout/stderr split honestly.
 */
export async function startMockServer(
  api: MockApi,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
      const request = new Request(url, {
        method: req.method,
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await api.handle(request);
      const body = Buffer.from(await response.arrayBuffer());
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        out[key] = value;
      });
      res.writeHead(response.status, out);
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
