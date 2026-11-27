// @vitest-environment node
// The Refund Console's server actions (Module 4), called directly the way any
// visitor could call them over HTTP: without a supervisor session they change
// nothing and reveal nothing. The customer chat can't reach them at all.
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined,
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

import {
  decide,
  loadDesk,
  saveLimit,
  signIn,
  signOut,
} from "@/app/support/actions";
import {
  refundAgentTools,
  singleAgentTools,
} from "@/lib/copper/assistant/tools";
import { createMemoryRefundStore } from "@/lib/copper/refund-store";
import {
  configureRefunds,
  type Payout,
  requestRefund,
} from "@/lib/copper/refunds";
import { SESSION_COOKIE, sessionToken } from "@/lib/copper/supervisor-auth";

const PASSCODE = "correct-horse-battery";
const SECRET = "s".repeat(40);
const DENIED = "Only a signed-in supervisor can do that.";

let store = createMemoryRefundStore();
let payout = vi.fn<Payout>(async () => {});

beforeEach(async () => {
  jar.values.clear();
  vi.stubEnv("SUPERVISOR_PASSCODE", PASSCODE);
  vi.stubEnv("SUPERVISOR_SESSION_SECRET", SECRET);
  (globalThis as { __copperSignInFailures?: unknown }).__copperSignInFailures =
    undefined;
  store = createMemoryRefundStore();
  payout = vi.fn<Payout>(async () => {});
  configureRefunds({ store, payout });
  await requestRefund("1004"); // $149, over the $50 limit: waiting
});

const status = async () => (await store.get("1004"))?.status;

describe("without a supervisor session (a customer, or anyone with the URL)", () => {
  it.each(["approve", "reject"] as const)(
    "cannot %s a refund",
    async (decision) => {
      expect(await decide("1004", decision)).toEqual({
        ok: false,
        error: DENIED,
      });
      expect(await status()).toBe("pending");
      expect(payout).not.toHaveBeenCalled();
    },
  );

  it("cannot change the limit, so can't raise it to get refunds paid", async () => {
    expect(await saveLimit("1000000")).toEqual({ ok: false, error: DENIED });
    expect(await saveLimit("0")).toEqual({ ok: false, error: DENIED });
    expect(await store.getLimitCents()).toBe(5000);
    // And the over-limit order still waits.
    expect((await requestRefund("1003")).status).toBe("needs_approval");
  });

  it("cannot approve by sending nonsense either: the check comes first", async () => {
    // @ts-expect-error a visitor can send any value over HTTP
    expect(await decide("1004", "approve; DROP TABLE refunds")).toEqual({
      ok: false,
      error: DENIED,
    });
    expect(await status()).toBe("pending");
  });

  it("sees orders and their status, but not the limit", async () => {
    const result = await loadDesk();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.supervisor).toBe(false);
    expect(result.view.limitCents).toBeUndefined();
    expect(result.view.orders.map((o) => o.refund?.status ?? null)).toEqual([
      null,
      null,
      null,
      "pending",
    ]);
    // Not even the limit a request was held against.
    expect(JSON.stringify(result.view)).not.toContain("5000");
  });

  it("is told the truth when sign-in isn't set up", async () => {
    vi.stubEnv("SUPERVISOR_PASSCODE", "");
    const result = await loadDesk();
    expect(result.ok && result.view.signInAvailable).toBe(false);
  });
});

describe("with a forged or expired session", () => {
  const attempts: [string, () => string][] = [
    ["a made-up cookie", () => "supervisor"],
    [
      "a wrong signature",
      () => `${Math.floor(Date.now() / 1000) + 3600}.${"a".repeat(64)}`,
    ],
    [
      "a token from another secret",
      () => sessionToken("x".repeat(40), Math.floor(Date.now() / 1000) + 3600),
    ],
    [
      "an expired token",
      () => sessionToken(SECRET, Math.floor(Date.now() / 1000) - 5),
    ],
  ];
  it.each(attempts)(
    "%s can't approve, reject or change the limit",
    async (_n, token) => {
      jar.values.set(SESSION_COOKIE, token());
      expect((await decide("1004", "approve")).ok).toBe(false);
      expect((await decide("1004", "reject")).ok).toBe(false);
      expect((await saveLimit("999")).ok).toBe(false);
      expect(await status()).toBe("pending");
      expect(await store.getLimitCents()).toBe(5000);
      expect(payout).not.toHaveBeenCalled();
    },
  );
});

describe("signing in", () => {
  it("a wrong passcode gives no access", async () => {
    const result = await signIn("wrong-passcode");
    expect(result.ok).toBe(false);
    expect(result.view?.supervisor).toBe(false);
    expect((await decide("1004", "approve")).ok).toBe(false);
  });

  it("a signed-in supervisor can approve once, and the decision is theirs", async () => {
    const result = await signIn(PASSCODE);
    expect(result.ok && result.view.supervisor).toBe(true);
    expect(result.ok && result.view.limitCents).toBe(5000);
    expect(await decide("1004", "approve")).toMatchObject({
      ok: true,
      orderId: "1004",
    });
    expect(await store.get("1004")).toMatchObject({
      status: "refunded",
      decidedBy: "supervisor",
    });
    expect(payout).toHaveBeenCalledTimes(1);
    // A repeat does nothing.
    expect(await decide("1004", "approve")).toMatchObject({ ok: false });
    expect(payout).toHaveBeenCalledTimes(1);
  });

  it("a signed-in supervisor can reject, and can change the limit", async () => {
    await signIn(PASSCODE);
    expect(await decide("1004", "reject")).toMatchObject({ ok: true });
    expect(await status()).toBe("rejected");
    expect(await saveLimit("75")).toMatchObject({ ok: true });
    expect(await store.getLimitCents()).toBe(7500);
    expect((await saveLimit("-1")).ok).toBe(false);
  });

  it("signing out takes the access away again", async () => {
    await signIn(PASSCODE);
    await signOut();
    expect(await decide("1004", "approve")).toEqual({
      ok: false,
      error: DENIED,
    });
    expect(await status()).toBe("pending");
  });
});

describe("the customer-facing agent has no way to decide", () => {
  it("has no tool that approves, rejects or sets the limit", () => {
    const allowed = [
      "get_orders",
      "request_refund",
      "transfer_to_copper",
      "calculate_cost",
      "check_availability",
      "get_prices",
      "get_products",
      "search_docs",
    ];
    for (const name of [
      ...Object.keys(refundAgentTools()),
      ...Object.keys(singleAgentTools()),
    ])
      expect(allowed).toContain(name);
  });

  it("calling its refund tool over and over never settles a waiting request", async () => {
    const tools = refundAgentTools();
    for (let i = 0; i < 3; i++) {
      const result = await tools.request_refund.execute!({ orderId: "1004" }, {
        toolCallId: "t",
        messages: [],
        context: {},
      } as never);
      expect(result).toMatchObject({ status: "waiting" });
    }
    expect(await status()).toBe("pending");
    expect(payout).not.toHaveBeenCalled();
  });

  it("the assistant's code never imports the console actions or the decision function", () => {
    const dir = "lib/copper/assistant";
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(`${dir}/${file}`, "utf8");
      expect(source, file).not.toMatch(/app\/support\/actions/);
      expect(source, file).not.toMatch(/\bdecideRefund\b/);
      expect(source, file).not.toMatch(/\bupdateLimit\b/);
      expect(source, file).not.toMatch(/supervisor-auth/);
    }
  });
});
