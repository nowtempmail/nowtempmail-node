/**
 * Error mapping.
 *
 * The point of these tests is that a caller can branch on `err.code` and get the
 * same answer forever. Every documented problem code gets its own class, every
 * error carries the request id support will ask for, and a body that is not a
 * problem document still produces something sensible instead of a parse crash.
 */

import { describe, expect, it } from "vitest";
import { MOCK_KEY, createMockApi } from "../helpers/mock-api.js";
import { NowTempMail } from "../../src/client.js";
import {
  AccountSuspendedError,
  AddressReservedError,
  AddressTakenError,
  ForbiddenError,
  InternalError,
  InvalidKeyError,
  InvalidRequestError,
  KeyRevokedError,
  NotFoundError,
  NowTempMailError,
  OriginNotAllowedError,
  PlanUpgradeRequiredError,
  QuotaExceededError,
  RateLimitExceededError,
  UnauthorizedError,
} from "../../src/errors.js";
import { PROBLEM_CODES } from "../../src/types.js";
import type { ProblemCode } from "../../src/types.js";

const EXPECTED: Record<ProblemCode, typeof NowTempMailError> = {
  unauthorized: UnauthorizedError,
  invalid_key: InvalidKeyError,
  key_revoked: KeyRevokedError,
  account_suspended: AccountSuspendedError,
  forbidden: ForbiddenError,
  origin_not_allowed: OriginNotAllowedError,
  plan_upgrade_required: PlanUpgradeRequiredError,
  not_found: NotFoundError,
  address_taken: AddressTakenError,
  address_reserved: AddressReservedError,
  invalid_request: InvalidRequestError,
  rate_limit_exceeded: RateLimitExceededError,
  quota_exceeded: QuotaExceededError,
  internal_error: InternalError,
};

function clientFor(fetchImpl: typeof globalThis.fetch, maxRetries = 0): NowTempMail {
  return new NowTempMail({ apiKey: MOCK_KEY, fetch: fetchImpl, maxRetries });
}

describe("problem code mapping", () => {
  // 14 codes, one assertion block each. Retries are off so the injected failure
  // is the response the caller sees.
  it.each([...PROBLEM_CODES])("maps %s to its own class and keeps the requestId", async (code) => {
    const api = createMockApi({ failNext: { count: 1, code } });
    const client = clientFor(api.fetch);

    let thrown: unknown;
    try {
      await client.me();
    } catch (err) {
      thrown = err;
    }

    const expected = EXPECTED[code];
    expect(thrown).toBeInstanceOf(expected);
    expect(NowTempMailError.is(thrown)).toBe(true);

    const err = thrown as NowTempMailError;
    expect(err.code).toBe(code);
    expect(err.name).toBe(expected.name);
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/v1/me");
    expect(err.requestId).toMatch(/^req_[A-Za-z0-9_-]{16,32}$/);
    expect(err.status).toBeTypeOf("number");
    expect(err.message).not.toContain(MOCK_KEY);
    expect(err.toLogString()).not.toContain(MOCK_KEY);
  });

  it("carries Retry-After on the two 429 codes", async () => {
    for (const code of ["rate_limit_exceeded", "quota_exceeded"] as const) {
      const api = createMockApi({ failNext: { count: 1, code } });
      await expect(clientFor(api.fetch).me()).rejects.toMatchObject({
        code,
        status: 429,
        retryAfter: 2,
      });
    }
  });

  it("exposes the 402 hints a caller needs to act", async () => {
    // A free plan rejecting a custom address is the real-world 402.
    const api = createMockApi();
    const client = clientFor(api.fetch);
    let thrown: unknown;
    try {
      await client.mailboxes.create({ address: "qa-fixture-01" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanUpgradeRequiredError);
    expect(thrown).toMatchObject({
      code: "plan_upgrade_required",
      parameter: "address",
      plan: "free",
      maxTtlSeconds: 86_400,
      method: "POST",
      path: "/v1/mailboxes",
    });
  });
});

describe("NowTempMailError.is", () => {
  it("brands every error this package throws", async () => {
    const api = createMockApi();
    const client = clientFor(api.fetch);
    let thrown: unknown;
    try {
      await client.mailboxes.get("nobody@allogebra.com");
    } catch (err) {
      thrown = err;
    }
    expect(NowTempMailError.is(thrown)).toBe(true);
    expect((thrown as NowTempMailError).code).toBe("not_found");
  });

  it("is false for anything else, including a lookalike", () => {
    expect(NowTempMailError.is(new Error("nope"))).toBe(false);
    expect(NowTempMailError.is({ code: "not_found", requestId: "req_x" })).toBe(false);
    expect(NowTempMailError.is(null)).toBe(false);
    expect(NowTempMailError.is("not_found")).toBe(false);
  });

  it("survives a second copy of the class — the dual-package hazard", () => {
    // A CJS consumer plus an ESM fixture means two class objects for the same
    // error. Stand one in: same registry-global brand, unrelated prototype.
    // `instanceof` gets it wrong, which is exactly why `is` exists.
    const fromAnotherCopy = Object.assign(Object.create(Error.prototype) as Error, {
      code: "not_found",
      requestId: "req_abcdefghijklmnopqrst",
    });
    Object.defineProperty(fromAnotherCopy, Symbol.for("nowtempmail.error"), {
      value: true,
      enumerable: false,
    });

    expect(fromAnotherCopy instanceof NotFoundError).toBe(false);
    expect(NowTempMailError.is(fromAnotherCopy)).toBe(true);
    expect((fromAnotherCopy as unknown as NowTempMailError).code).toBe("not_found");
  });
});

describe("responses that are not problem documents", () => {
  const rid = "req_abcdefghijklmnopqrst";

  it("turns an HTML 502 from a proxy into an InternalError with a requestId", async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html", "X-Request-Id": rid },
      });

    let thrown: unknown;
    try {
      await clientFor(fetchImpl).me();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternalError);
    const err = thrown as NowTempMailError;
    expect(err.code).toBe("internal_error");
    expect(err.status).toBe(502);
    expect(err.requestId).toBe(rid);
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/v1/me");
    // The raw body is never echoed back — it could be megabytes of markup.
    expect(err.message).not.toContain("<html>");
  });

  it("falls back to the request id we sent when the body has none", async () => {
    let sent: string | null = null;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      sent = new Headers(init?.headers).get("X-Request-Id");
      return new Response("", { status: 404 });
    };
    let thrown: unknown;
    try {
      await clientFor(fetchImpl).me();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    expect((thrown as NowTempMailError).requestId).toBe(sent);
    expect(sent).toMatch(/^req_[A-Za-z0-9_-]{16,32}$/);
  });

  it("keeps an unknown future code rather than crashing on it", async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          type: "https://nowtempmail.com/developers/errors#teapot",
          code: "teapot",
          title: "Teapot",
          status: 418,
          detail: "A fifteenth code shipped.",
          requestId: rid,
        }),
        { status: 418, headers: { "Content-Type": "application/problem+json" } },
      );
    let thrown: unknown;
    try {
      await clientFor(fetchImpl).me();
    } catch (err) {
      thrown = err;
    }
    expect(NowTempMailError.is(thrown)).toBe(true);
    // An unrecognised code is passed through on the base class. An older client
    // must not break when the server grows a code.
    expect((thrown as NowTempMailError).code).toBe("teapot");
    expect((thrown as NowTempMailError).requestId).toBe(rid);
  });

  it("rejects a 200 whose body is not JSON", async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Request-Id": rid },
      });
    let thrown: unknown;
    try {
      await clientFor(fetchImpl).me();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternalError);
    expect((thrown as NowTempMailError).requestId).toBe(rid);
  });

  it("still errors when the transport hands back nothing at all", async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    let thrown: unknown;
    try {
      await clientFor(fetchImpl).me();
    } catch (err) {
      thrown = err;
    }
    expect(NowTempMailError.is(thrown)).toBe(true);
    const err = thrown as NowTempMailError;
    expect(err.code).toBe("connection_error");
    expect(err.retryable).toBe(true);
    expect(err.method).toBe("GET");
    expect(err.path).toBe("/v1/me");
    expect(err.requestId).toMatch(/^req_/);
  });
});
