/**
 * The transport, and the five security properties it exists to hold.
 *
 * These are the tests that would catch a well-meaning refactor undoing a
 * decision from the security review: retrying a mailbox creation, following a
 * redirect with the bearer token attached, handing an `Authorization` header to
 * a logging hook, or accepting an http baseUrl.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_KEY, createMockApi } from "../helpers/mock-api.js";
import { DEFAULT_BASE_URL, NowTempMail } from "../../src/client.js";
import type { ClientOptions } from "../../src/client.js";
import { ConfigError, MailboxMayExistError, NowTempMailError } from "../../src/errors.js";
import { createRequire } from "node:module";
import {
  MIN_POLL_INTERVAL_MS,
  REQUEST_ID_PATTERN,
  VERSION,
  generateRequestId,
  parseRetryAfter,
  readMetering,
} from "../../src/http.js";
import type { RequestHookEvent, ResponseHookEvent } from "../../src/http.js";

/**
 * The guard that keeps `VERSION` honest.
 *
 * `src/http.ts` duplicates the manifest version so the User-Agent can carry it
 * without importing package.json. Nothing else checks the two agree: the release
 * workflow compares the git tag against package.json and never looks at this
 * constant, so without this test the User-Agent can report a stale version
 * forever — and npm versions are immutable, so "forever" is literal.
 */
describe("VERSION", () => {
  it("matches the version in package.json", () => {
    const manifest = createRequire(import.meta.url)("../../package.json") as {
      version: string;
    };
    expect(VERSION).toBe(manifest.version);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function client(overrides: Partial<ClientOptions> = {}): NowTempMail {
  const api = createMockApi();
  return new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch, ...overrides });
}

/** Let every pending microtask settle without moving the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/* -------------------------------------------------------------------------- */

describe("configuration", () => {
  it("defaults to the apex domain, not api.nowtempmail.com", () => {
    // api.nowtempmail.com is unconfirmed in the spec's servers block and may not
    // resolve. The apex is where /v1 actually answers.
    expect(DEFAULT_BASE_URL).toBe("https://nowtempmail.com");
    expect(new NowTempMail(MOCK_KEY).baseUrl).toBe("https://nowtempmail.com");
  });

  it("accepts an apiKey string as shorthand", () => {
    expect(new NowTempMail(MOCK_KEY).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("reads NTM_API_KEY when no key is passed", () => {
    vi.stubEnv("NTM_API_KEY", MOCK_KEY);
    expect(() => new NowTempMail()).not.toThrow();
    vi.stubEnv("NTM_API_KEY", "");
    expect(() => new NowTempMail()).toThrowError(ConfigError);
  });

  it("rejects a non-https baseUrl", () => {
    for (const bad of [
      "http://nowtempmail.com",
      "http://internal.corp/v1",
      "ftp://nowtempmail.com",
      "https://user:pass@nowtempmail.com",
      "not-a-url",
    ]) {
      let thrown: unknown;
      try {
        new NowTempMail({ apiKey: MOCK_KEY, baseUrl: bad });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `expected ${bad} to be refused`).toBeInstanceOf(ConfigError);
      expect((thrown as NowTempMailError).code).toBe("config_error");
    }
  });

  it("allows plain http on an explicit loopback host, for wrangler dev", () => {
    expect(new NowTempMail({ apiKey: MOCK_KEY, baseUrl: "http://localhost:8787" }).baseUrl).toBe(
      "http://localhost:8787",
    );
    expect(new NowTempMail({ apiKey: MOCK_KEY, baseUrl: "http://127.0.0.1:8787/" }).baseUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("strips a trailing slash so paths do not double up", () => {
    expect(new NowTempMail({ apiKey: MOCK_KEY, baseUrl: "https://example.com/" }).baseUrl).toBe(
      "https://example.com",
    );
  });

  it("does not trip the browser refusal in a jsdom-shaped environment", () => {
    // document present AND process.versions.node present. A test environment,
    // not a browser. This is the false positive the narrow check avoids.
    vi.stubGlobal("document", {});
    expect(typeof document).not.toBe("undefined");
    expect(() => new NowTempMail(MOCK_KEY)).not.toThrow();
  });

  it("refuses construction in a real browser", () => {
    const realProcess = globalThis.process;
    vi.stubGlobal("document", {});
    // A browser has no process.versions.node. Restored synchronously, before
    // anything else can observe the stub.
    Object.defineProperty(globalThis, "process", {
      value: { env: {} },
      configurable: true,
      writable: true,
    });
    let thrown: unknown;
    try {
      new NowTempMail({ apiKey: MOCK_KEY });
    } catch (err) {
      thrown = err;
    } finally {
      Object.defineProperty(globalThis, "process", {
        value: realProcess,
        configurable: true,
        writable: true,
      });
    }
    expect(NowTempMailError.is(thrown)).toBe(true);
    expect((thrown as NowTempMailError).code).toBe("browser_use_refused");
  });

  it("dangerouslyAllowBrowser bypasses the refusal", () => {
    const realProcess = globalThis.process;
    vi.stubGlobal("document", {});
    Object.defineProperty(globalThis, "process", {
      value: { env: {} },
      configurable: true,
      writable: true,
    });
    let thrown: unknown;
    try {
      new NowTempMail({ apiKey: MOCK_KEY, dangerouslyAllowBrowser: true });
    } catch (err) {
      thrown = err;
    } finally {
      Object.defineProperty(globalThis, "process", {
        value: realProcess,
        configurable: true,
        writable: true,
      });
    }
    expect(thrown).toBeUndefined();
  });

  it("rejects nonsense timeouts and retry counts", () => {
    expect(() => new NowTempMail({ apiKey: MOCK_KEY, timeoutMs: 0 })).toThrowError(ConfigError);
    expect(() => new NowTempMail({ apiKey: MOCK_KEY, maxRetries: -1 })).toThrowError(ConfigError);
    expect(() => new NowTempMail({ apiKey: MOCK_KEY, maxRetries: 1.5 })).toThrowError(ConfigError);
  });
});

/* -------------------------------------------------------------------------- */

describe("request identity", () => {
  it("generates ids matching the documented pattern", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRequestId()).toMatch(REQUEST_ID_PATTERN);
    }
    expect(new Set(Array.from({ length: 50 }, generateRequestId)).size).toBe(50);
  });

  it("sends a generated X-Request-Id on every request", async () => {
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    await ntm.me();
    await ntm.domains.list();
    expect(api.requests).toHaveLength(2);
    for (const seen of api.requests) {
      expect(seen.requestId).toMatch(REQUEST_ID_PATTERN);
    }
    expect(api.requests[0]!.requestId).not.toBe(api.requests[1]!.requestId);
  });

  it("forwards a caller-supplied id that matches the pattern", async () => {
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    const mine = "req_MyOwnCorrelationId1";
    expect(mine).toMatch(REQUEST_ID_PATTERN);
    await ntm.http.request({ method: "GET", path: "/v1/me", requestId: mine });
    expect(api.requests[0]!.requestId).toBe(mine);
  });

  it("refuses an arbitrary caller-supplied id rather than forwarding it", async () => {
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    for (const bad of ["hello", "req_short", "req_" + "x".repeat(40), "req_bad\nInjected: 1"]) {
      await expect(
        ntm.http.request({ method: "GET", path: "/v1/me", requestId: bad }),
      ).rejects.toBeInstanceOf(ConfigError);
    }
    // Nothing reached the wire.
    expect(api.requests).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("credential handling", () => {
  it("sends the key as a bearer token and nothing else", async () => {
    const api = createMockApi();
    const seen: Headers[] = [];
    const spy: typeof globalThis.fetch = (input, init) => {
      seen.push(new Headers(init?.headers));
      return api.fetch(input, init);
    };
    await new NowTempMail({ apiKey: MOCK_KEY, fetch: spy }).me();
    expect(seen[0]!.get("Authorization")).toBe(`Bearer ${MOCK_KEY}`);
    // No Origin: /v1 rejects any request carrying one, before it reads the key.
    expect(seen[0]!.get("Origin")).toBeNull();
    expect(seen[0]!.get("User-Agent")).toMatch(/^nowtempmail-node\//);
  });

  it("never shows the Authorization header or the key to a hook", async () => {
    const api = createMockApi();
    const requests: RequestHookEvent[] = [];
    const responses: ResponseHookEvent[] = [];
    const ntm = new NowTempMail({
      apiKey: MOCK_KEY,
      fetch: api.fetch,
      onRequest: (e) => requests.push(e),
      onResponse: (e) => responses.push(e),
    });

    await ntm.me();
    const mailbox = await ntm.mailboxes.create();
    await mailbox.messages.page();

    expect(requests.length).toBeGreaterThan(2);
    for (const event of requests) {
      const names = Object.keys(event.headers).map((k) => k.toLowerCase());
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("proxy-authorization");
      expect(names).not.toContain("cookie");
      expect(JSON.stringify(event)).not.toContain(MOCK_KEY);
      // The key's secret half must not appear even in fragments.
      expect(JSON.stringify(event)).not.toContain(MOCK_KEY.split("_")[3]!);
      expect(event.requestId).toMatch(REQUEST_ID_PATTERN);
      expect(event.attempt).toBeGreaterThanOrEqual(1);
    }
    for (const event of responses) {
      expect(JSON.stringify(event)).not.toContain(MOCK_KEY);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.status).toBeGreaterThanOrEqual(200);
    }
  });

  it("gives hooks a frozen header object they cannot use to inject one", async () => {
    const api = createMockApi();
    let leaked: unknown;
    const ntm = new NowTempMail({
      apiKey: MOCK_KEY,
      fetch: api.fetch,
      onRequest: (e) => {
        try {
          (e.headers as Record<string, string>)["Authorization"] = "Bearer attacker";
        } catch {
          /* frozen, as intended */
        }
        leaked = (e.headers as Record<string, string>)["Authorization"];
      },
    });
    await ntm.me();
    expect(leaked).toBeUndefined();
  });

  it("does not let a throwing hook break the request", async () => {
    const api = createMockApi();
    const ntm = new NowTempMail({
      apiKey: MOCK_KEY,
      fetch: api.fetch,
      onRequest: () => {
        throw new Error("bad logger");
      },
      onResponse: () => {
        throw new Error("bad logger");
      },
    });
    await expect(ntm.me()).resolves.toMatchObject({ keyId: "k7Rm2xQp9Ldv" });
  });
});

/* -------------------------------------------------------------------------- */

describe("redirects", () => {
  it("asks fetch to error rather than follow a Location", async () => {
    const api = createMockApi();
    const inits: RequestInit[] = [];
    const spy: typeof globalThis.fetch = (input, init) => {
      inits.push(init ?? {});
      return api.fetch(input, init);
    };
    await new NowTempMail({ apiKey: MOCK_KEY, fetch: spy }).me();
    // Following a redirect would replay the bearer token to a host we did not
    // choose. There is no configuration that turns this off.
    expect(inits[0]!.redirect).toBe("error");
  });

  it("reports a redirect as a connection error naming the reason", async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new TypeError("unexpected redirect, redirect mode is set to error");
    };
    let thrown: unknown;
    try {
      await new NowTempMail({ apiKey: MOCK_KEY, fetch: fetchImpl, maxRetries: 0 }).me();
    } catch (err) {
      thrown = err;
    }
    expect((thrown as NowTempMailError).code).toBe("connection_error");
    expect((thrown as NowTempMailError).message).toMatch(/redirect/i);
    expect((thrown as NowTempMailError).message).toMatch(/API key/i);
  });
});

/* -------------------------------------------------------------------------- */

describe("retries", () => {
  it("retries a GET on 429 and sleeps exactly Retry-After", async () => {
    vi.useFakeTimers();
    const api = createMockApi({ failNext: { count: 1, code: "rate_limit_exceeded" } });
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch, maxRetries: 2 });

    const pending = ntm.me();
    await flush();
    // First attempt is spent; the mock's Retry-After is 2 seconds.
    expect(api.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_900);
    expect(api.requests, "must not retry before Retry-After elapses").toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ keyId: "k7Rm2xQp9Ldv" });
    expect(api.requests).toHaveLength(2);
  });

  it("retries a GET on 500 and gives up after maxRetries", async () => {
    const api = createMockApi({ failNext: { count: 99, code: "internal_error" } });
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch, maxRetries: 2 });
    await expect(ntm.me()).rejects.toMatchObject({ code: "internal_error" });
    expect(api.requests).toHaveLength(3); // 1 attempt + 2 retries
  });

  it("retries a GET after a transport failure", async () => {
    const api = createMockApi();
    let calls = 0;
    const flaky: typeof globalThis.fetch = (input, init) => {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
      return api.fetch(input, init);
    };
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: flaky, maxRetries: 2 });
    await expect(ntm.me()).resolves.toMatchObject({ keyId: "k7Rm2xQp9Ldv" });
    expect(calls).toBe(2);
  });

  it("does not retry a 404 — retrying will not conjure the resource", async () => {
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch, maxRetries: 2 });
    await expect(ntm.mailboxes.get("nobody@allogebra.com")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(api.requests).toHaveLength(1);
  });

  it("makes exactly one request when maxRetries is 0", async () => {
    const api = createMockApi({ failNext: { count: 99, code: "internal_error" } });
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch, maxRetries: 0 });
    await expect(ntm.me()).rejects.toMatchObject({ code: "internal_error" });
    expect(api.requests).toHaveLength(1);
  });
});

describe("mailbox creation is never retried", () => {
  it("throws MailboxMayExistError after exactly one POST", async () => {
    const api = createMockApi();
    // The request reaches the server and the response is lost on the way back —
    // the worst case, because quota is already spent.
    const lossy: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/mailboxes") {
        await api.handle(request);
        throw new TypeError("fetch failed: socket hang up");
      }
      return api.handle(request);
    };
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: lossy, maxRetries: 5 });

    let thrown: unknown;
    try {
      await ntm.mailboxes.create();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MailboxMayExistError);
    const err = thrown as NowTempMailError;
    expect(err.code).toBe("mailbox_may_exist");
    expect(err.message).toMatch(/quota/i);
    expect(err.cause).toBeDefined();

    const posts = api.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/mailboxes",
    );
    expect(posts, "a second POST would silently spend another mailbox").toHaveLength(1);
    // And the mailbox really does exist server-side, which is why the error says so.
    expect(api.state.mailboxes.size).toBe(1);
    expect(api.state.mailboxesToday).toBe(1);
  });

  it("does not retry a 500 on creation either", async () => {
    const api = createMockApi({ failNext: { count: 99, code: "internal_error" } });
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch, maxRetries: 5 });
    await expect(ntm.mailboxes.create()).rejects.toMatchObject({ code: "internal_error" });
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("does not retry a 429 quota_exceeded on creation", async () => {
    const api = createMockApi({ failNext: { count: 99, code: "quota_exceeded" } });
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch, maxRetries: 5 });
    await expect(ntm.mailboxes.create()).rejects.toMatchObject({
      code: "quota_exceeded",
      retryAfter: 2,
    });
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe("timeouts and cancellation", () => {
  it("gives up after timeoutMs", async () => {
    vi.useFakeTimers();
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const ntm = new NowTempMail({
      apiKey: MOCK_KEY,
      fetch: hang,
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    const pending = ntm.me();
    const assertion = expect(pending).rejects.toMatchObject({ code: "connection_error" });
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
  });

  it("honours a caller AbortSignal without retrying", async () => {
    const controller = new AbortController();
    let calls = 0;
    const hang: typeof globalThis.fetch = (_input, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: hang, maxRetries: 3 });
    const pending = ntm.http.request({
      method: "GET",
      path: "/v1/me",
      signal: controller.signal,
    });
    controller.abort(new Error("caller changed their mind"));
    await expect(pending).rejects.toMatchObject({ code: "connection_error" });
    expect(calls, "an aborted request is not retried").toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

describe("metering", () => {
  it("starts empty and fills in from response headers", async () => {
    const api = createMockApi();
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    expect(ntm.metering).toEqual({ rateLimit: null, quota: null });

    await ntm.me();
    expect(ntm.metering.rateLimit).toMatchObject({ limit: 30, remaining: 30 });
    expect(ntm.metering.quota).toMatchObject({ limit: 50, remaining: 50 });
    expect(ntm.metering.rateLimit!.reset).toBeInstanceOf(Date);
  });

  it("keeps the previous snapshot when a response omits a header set", () => {
    // The attachment download route carries X-Request-Id but no rate-limit
    // headers. Clearing the snapshot there would make the poll interval jump.
    const partial = readMetering(new Headers({ "X-Request-Id": "req_abcdefghijklmnopqrst" }));
    expect(partial).toEqual({ rateLimit: null, quota: null });
  });

  it("fires onLowQuota when the remaining count crosses the threshold", async () => {
    const api = createMockApi({ plan: { mailboxesPerDay: 3 } });
    const events: Array<{ remaining: number; limit: number }> = [];
    const ntm = new NowTempMail({
      apiKey: MOCK_KEY,
      fetch: api.fetch,
      lowQuotaThreshold: 3,
      onLowQuota: (e) => events.push({ remaining: e.remaining, limit: e.limit }),
    });

    await ntm.me(); // remaining 3, not below 3
    expect(events).toHaveLength(0);
    await ntm.mailboxes.create(); // remaining drops to 2
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ remaining: 2, limit: 3 });
  });

  it("parses both Retry-After forms", () => {
    expect(parseRetryAfter("2")).toBe(2);
    expect(parseRetryAfter(" 18 ")).toBe(18);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
    const future = new Date(Date.now() + 5_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(0);
  });
});

describe("poll interval derivation", () => {
  it("divides the per-minute limit across watchers, with a 2s floor", async () => {
    const api = createMockApi({ plan: { requestsPerMinute: 60 } });
    const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
    const http = ntm.http;

    // Before any response the fallback is the Free limit of 30/min → exactly 2s.
    expect(http.pollIntervalMs(1)).toBe(MIN_POLL_INTERVAL_MS);

    await ntm.me(); // learns 60/min
    expect(http.pollIntervalMs(1)).toBe(MIN_POLL_INTERVAL_MS); // 1000ms → floored
    expect(http.pollIntervalMs(3)).toBe(3_000);
    expect(http.pollIntervalMs(6)).toBe(6_000);
    expect(http.pollIntervalMs(0)).toBe(MIN_POLL_INTERVAL_MS);
  });

  it("counts watchers in and out", () => {
    const http = client().http;
    expect(http.watchers).toBe(0);
    const releaseA = http.registerWatcher();
    const releaseB = http.registerWatcher();
    expect(http.watchers).toBe(2);
    releaseB();
    releaseB(); // idempotent
    expect(http.watchers).toBe(1);
    releaseA();
    expect(http.watchers).toBe(0);
  });
});
