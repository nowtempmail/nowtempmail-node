/**
 * The client surface: `me`, `domains`, `mailboxes`, `reservations`, `webhooks`,
 * and the create-then-confirm handshake.
 *
 * The confirmation tests are the important ones. The API can return a mailbox
 * before that mailbox is readable, and mail arriving inside that window is lost
 * rather than queued, so a handle returned before confirmation hands the caller
 * a race they cannot see and cannot debug — the mail simply never arrives.
 */

import { describe, expect, it } from "vitest";
import { MOCK_KEY, createMockApi } from "../helpers/mock-api.js";
import type { MockApiOptions } from "../helpers/mock-api.js";
import { NowTempMail } from "../../src/client.js";
import { Mailbox } from "../../src/mailbox.js";
import { NotFoundError } from "../../src/errors.js";

function setup(options: MockApiOptions = {}) {
  // Pin the mock clock to the real one. Its default is a fixed instant that has
  // since gone by, which would make every mailbox it mints already expired.
  const api = createMockApi({ now: () => Date.now(), ...options });
  const ntm = new NowTempMail({ apiKey: MOCK_KEY, fetch: api.fetch });
  return { api, ntm };
}

describe("me()", () => {
  it("turns every epoch field into a Date and passes the plan through", async () => {
    const { ntm } = setup();
    const account = await ntm.me();

    expect(account.keyId).toBe("k7Rm2xQp9Ldv");
    expect(account.environment).toBe("live");
    expect(account.paywall.enabled).toBe(false);
    expect(account.subscription).toBeNull();
    expect(account.plan.mailboxesPerDay).toBe(50);
    expect(account.usage.resetsAt.minute).toBeInstanceOf(Date);
    expect(account.usage.resetsAt.day).toBeInstanceOf(Date);
    expect(account.usage.resetsAt.minute.getTime()).toBeGreaterThan(0);
    expect(account.webhookEndpoints).toEqual([]);
  });

  it("converts webhook endpoint health timestamps, nulls included", async () => {
    const { api, ntm } = setup({ plan: { webhooks: true } });
    await ntm.mailboxes.create({ webhookUrl: "https://example.com/hooks/ntm" });
    const account = await ntm.me();
    expect(api.state.webhookEndpoints).toHaveLength(1);
    expect(account.webhookEndpoints[0]).toMatchObject({
      url: "https://example.com/hooks/ntm",
      status: "active",
      consecutiveFailures: 0,
      lastSuccessAt: null,
      disabledAt: null,
    });
  });
});

describe("domains.list()", () => {
  it("returns the active domains and flags the default", async () => {
    const { ntm } = setup();
    const domains = await ntm.domains.list();
    expect(domains).toEqual([
      { domain: "allogebra.com", default: true },
      { domain: "mailtemp.dev", default: false },
    ]);
  });
});

describe("create-then-confirm", () => {
  it("does not resolve until one GET has confirmed readability", async () => {
    const { api, ntm } = setup();
    const mailbox = await ntm.mailboxes.create();

    expect(mailbox).toBeInstanceOf(Mailbox);
    expect(mailbox.confirmed).toBe(true);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/mailboxes",
      `GET /v1/mailboxes/${encodeURIComponent(mailbox.address)}`,
    ]);
  });

  it("still succeeds when the confirming read misses twice", async () => {
    // KV propagation lag. Two 404s, then the mailbox appears.
    const { api, ntm } = setup({ confirmMisses: 2 });
    const mailbox = await ntm.mailboxes.create();

    expect(mailbox.confirmed).toBe(true);
    expect(api.requests.filter((r) => r.method === "GET")).toHaveLength(3);
    expect(mailbox.address).toMatch(/@allogebra\.com$/);
  });

  it("resolves with confirmed: false rather than throwing when it never appears", async () => {
    // A working mailbox with a slow read beats an exception over a mailbox that
    // exists and has already cost a day's quota.
    const { api, ntm } = setup({ confirmMisses: 10 });
    const mailbox = await ntm.mailboxes.create();

    expect(mailbox.confirmed).toBe(false);
    // Exactly three attempts, and no more.
    expect(api.requests.filter((r) => r.method === "GET")).toHaveLength(3);
    // Everything creation told us is still intact.
    expect(mailbox.ttlSeconds).toBe(86_400);
    expect(mailbox.domain).toBe("allogebra.com");
    expect(mailbox.expiresAt.getTime() - mailbox.createdAt.getTime()).toBe(86_400_000);
    expect(api.state.mailboxes.has(mailbox.address)).toBe(true);
  });

  it("populates every field POST reports", async () => {
    const { ntm } = setup({
      plan: { customAddress: true, reservedAddresses: 5, webhooks: true, maxTtlSeconds: 604_800 },
    });
    const mailbox = await ntm.mailboxes.create({
      address: "qa-fixture-01",
      domain: "mailtemp.dev",
      ttlSeconds: 604_800,
      reserve: true,
      webhookUrl: "https://example.com/hooks/ntm",
    });

    expect(mailbox.address).toBe("qa-fixture-01@mailtemp.dev");
    expect(mailbox.localPart).toBe("qa-fixture-01");
    expect(mailbox.domain).toBe("mailtemp.dev");
    expect(mailbox.ttlSeconds).toBe(604_800);
    expect(mailbox.reserved).toBe(true);
    expect(mailbox.webhookUrl).toBe("https://example.com/hooks/ntm");
    expect(mailbox.messageCount).toBe(0);
    expect(mailbox.expired).toBe(false);
    expect(mailbox.expiresInMs).toBeGreaterThan(0);
  });

  it("omits absent params rather than sending undefined", async () => {
    const { api, ntm } = setup();
    let body: unknown;
    const spy = new NowTempMail({
      apiKey: MOCK_KEY,
      fetch: async (input, init) => {
        if (init?.method === "POST") body = JSON.parse(String(init.body));
        return api.fetch(input, init);
      },
    });
    await spy.mailboxes.create();
    expect(body).toEqual({});
    await spy.mailboxes.create({ ttlSeconds: 3_600 });
    expect(body).toEqual({ ttlSeconds: 3_600 });
  });
});

describe("mailboxes.get()", () => {
  it("verifies with one GET and derives what the narrow shape omits", async () => {
    const { api, ntm } = setup();
    const created = await ntm.mailboxes.create();
    api.requests.length = 0;

    const handle = await ntm.mailboxes.get(created.address.toUpperCase());
    expect(api.requests).toHaveLength(1);
    expect(handle.address).toBe(created.address);
    expect(handle.confirmed).toBe(true);
    // GET does not return ttlSeconds; expiresAt - createdAt is the same number.
    expect(handle.ttlSeconds).toBe(86_400);
    expect(handle.domain).toBe("allogebra.com");
    // Nor reserved / webhookUrl. They read as the safe default, not a guess.
    expect(handle.reserved).toBe(false);
    expect(handle.webhookUrl).toBeNull();
  });

  it("throws NotFoundError for a mailbox that is gone, expired or someone else's", async () => {
    const { ntm } = setup();
    await expect(ntm.mailboxes.get("nobody@allogebra.com")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("mailboxes.attach()", () => {
  it("makes no request at all", async () => {
    const { api, ntm } = setup();
    const handle = ntm.mailboxes.attach("Crystal400@Allogebra.com");
    expect(api.requests).toHaveLength(0);
    expect(handle.address).toBe("crystal400@allogebra.com");
    expect(handle.localPart).toBe("crystal400");
    expect(handle.domain).toBe("allogebra.com");
    expect(handle.confirmed).toBe(false);
  });

  it("reads as never-expiring and epoch-created until refreshed", async () => {
    const { ntm } = setup();
    const created = await ntm.mailboxes.create();
    const handle = ntm.mailboxes.attach(created.address);

    // Unknown expiry must not read as expired — that would make a live mailbox
    // look dead to any caller that checks before waiting.
    expect(handle.expired).toBe(false);
    expect(handle.expiresInMs).toBe(Number.POSITIVE_INFINITY);
    // Epoch createdAt means waitFor* considers mail that is already sitting there.
    expect(handle.createdAt.getTime()).toBe(0);
    expect(handle.ttlSeconds).toBe(0);

    await handle.refresh();
    expect(handle.confirmed).toBe(true);
    expect(handle.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(handle.expiresInMs).toBeGreaterThan(0);
    // ttlSeconds stays 0: the narrow GET does not report it, and refresh() is
    // not allowed to invent one. Use mailboxes.get() if you want it derived.
    expect(handle.ttlSeconds).toBe(0);
  });
});

describe("refresh()", () => {
  it("does not clobber the four fields the narrow GET omits", async () => {
    const { api, ntm } = setup({
      plan: { customAddress: true, reservedAddresses: 5, webhooks: true, maxTtlSeconds: 604_800 },
    });
    const mailbox = await ntm.mailboxes.create({
      address: "qa-fixture-02",
      ttlSeconds: 604_800,
      reserve: true,
      webhookUrl: "https://example.com/hooks/ntm",
    });

    api.deliver(mailbox.address);
    api.deliver(mailbox.address);
    await mailbox.refresh();

    // Updated from the wire…
    expect(mailbox.messageCount).toBe(2);
    expect(mailbox.lastMessageAt).toBeInstanceOf(Date);
    // …while everything GET cannot report survives.
    expect(mailbox.domain).toBe("allogebra.com");
    expect(mailbox.ttlSeconds).toBe(604_800);
    expect(mailbox.reserved).toBe(true);
    expect(mailbox.webhookUrl).toBe("https://example.com/hooks/ntm");
  });
});

describe("delete", () => {
  it("reports how many messages went with it", async () => {
    const { api, ntm } = setup();
    const mailbox = await ntm.mailboxes.create();
    api.deliver(mailbox.address);
    api.deliver(mailbox.address);

    const result = await ntm.mailboxes.delete(mailbox.address);
    expect(result).toEqual({ address: mailbox.address, deletedMessages: 2 });
    expect(api.state.mailboxes.has(mailbox.address)).toBe(false);
    // Deletion does not refund quota. Nothing in this SDK pretends otherwise.
    expect(api.state.mailboxesToday).toBe(1);
  });

  it("works from the handle too", async () => {
    const { api, ntm } = setup();
    const mailbox = await ntm.mailboxes.create();
    api.deliver(mailbox.address);
    await expect(mailbox.delete()).resolves.toEqual({ deletedMessages: 1 });
    expect(mailbox.messageCount).toBe(0);
  });
});

describe("reservations", () => {
  it("lists with Dates and a plan ceiling", async () => {
    const { ntm } = setup({ plan: { customAddress: true, reservedAddresses: 5 } });
    await ntm.mailboxes.create({ address: "held-address", reserve: true });

    const list = await ntm.reservations.list();
    expect(list.limit).toBe(5);
    expect(list.used).toBe(1);
    expect(list.reservations[0]!.address).toBe("held-address@allogebra.com");
    expect(list.reservations[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("releases by address and 404s the second time", async () => {
    const { ntm } = setup({ plan: { customAddress: true, reservedAddresses: 5 } });
    await ntm.mailboxes.create({ address: "held-address", reserve: true });

    await expect(ntm.reservations.release("held-address@allogebra.com")).resolves.toBeUndefined();
    expect((await ntm.reservations.list()).used).toBe(0);
    await expect(
      ntm.reservations.release("held-address@allogebra.com"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("webhooks", () => {
  it("queues a test delivery against the newest endpoint", async () => {
    const { ntm } = setup({ plan: { webhooks: true } });
    await ntm.mailboxes.create({ webhookUrl: "https://example.com/hooks/ntm" });

    const queued = await ntm.webhooks.test();
    expect(queued.queued).toBe(true);
    expect(queued.url).toBe("https://example.com/hooks/ntm");
    expect(queued.messageId).toMatch(/^test_/);
  });

  it("deletes an endpoint and then 404s", async () => {
    const { api, ntm } = setup({ plan: { webhooks: true } });
    await ntm.mailboxes.create({ webhookUrl: "https://example.com/hooks/ntm" });
    const id = api.state.webhookEndpoints[0]!.id;

    await expect(ntm.webhooks.delete(id)).resolves.toBeUndefined();
    expect(api.state.webhookEndpoints).toHaveLength(0);
    await expect(ntm.webhooks.delete(id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("422s when nothing is registered", async () => {
    const { ntm } = setup({ plan: { webhooks: true } });
    await expect(ntm.webhooks.test()).rejects.toMatchObject({ code: "invalid_request" });
  });
});
