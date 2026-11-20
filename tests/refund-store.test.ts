// @vitest-environment node
// The refund store keeps two promises: one refund per order, and a status
// changes only from the status expected. The same checks run against the
// in-memory store and against the Supabase store on a real Postgres (PGlite)
// with the real migration, so production behaves like the tests.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryRefundStore,
  type Refund,
  type RefundStore,
} from "@/lib/copper/refund-store";
import { createSupabaseRefundStore } from "@/lib/copper/refund-store-supabase";
import { supabaseOnPglite } from "./helpers/pglite-supabase";

const MIGRATION = "supabase/migrations/20261110000000_refunds.sql";

async function freshDb() {
  const db = new PGlite();
  await db.exec(readFileSync(MIGRATION, "utf8"));
  return db;
}

const refund = (orderId = "1004", over: Partial<Refund> = {}): Refund => ({
  orderId,
  item: "Copper Home",
  amountCents: 14900,
  currency: "USD",
  status: "pending",
  decidedBy: null,
  limitCents: 5000,
  requestedAt: "2026-11-19T10:00:00.000Z",
  decidedAt: null,
  ...over,
});

const stores: [string, () => Promise<RefundStore>][] = [
  ["memory", async () => createMemoryRefundStore()],
  [
    "Supabase on Postgres",
    async () => createSupabaseRefundStore(supabaseOnPglite(await freshDb())),
  ],
];

describe.each(stores)("refund store: %s", (_name, make) => {
  let store: RefundStore;
  beforeEach(async () => {
    store = await make();
  });

  it("starts with a $50 limit and saves a new one, including $0", async () => {
    expect(await store.getLimitCents()).toBe(5000);
    await store.setLimitCents(0);
    expect(await store.getLimitCents()).toBe(0);
    await store.setLimitCents(12050);
    expect(await store.getLimitCents()).toBe(12050);
  });

  it("creates a refund once; a second create returns the one that stands", async () => {
    const first = await store.create(refund());
    expect(first.created).toBe(true);
    const second = await store.create(refund("1004", { status: "processing" }));
    expect(second.created).toBe(false);
    expect(second.refund.status).toBe("pending");
    expect(await store.list()).toHaveLength(1);
  });

  it("lets only one of several simultaneous creates win", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.create(refund())),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("changes a status only from the status expected", async () => {
    await store.create(refund());
    expect(
      await store.transition("1004", ["processing"], { status: "refunded" }),
    ).toBeNull();
    expect((await store.get("1004"))?.status).toBe("pending");
    const claimed = await store.transition("1004", ["pending"], {
      status: "processing",
      decidedBy: "supervisor",
    });
    expect(claimed).toMatchObject({
      status: "processing",
      decidedBy: "supervisor",
    });
    expect(
      await store.transition("1004", ["pending"], { status: "rejected" }),
    ).toBeNull();
  });

  it("lets only one of several simultaneous decisions win", async () => {
    await store.create(refund());
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.transition("1004", ["pending"], {
          status: "processing",
          decidedBy: "supervisor",
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("removes a refund only in the status given", async () => {
    await store.create(refund("1001", { status: "processing" }));
    await store.remove("1001", "pending");
    expect(await store.get("1001")).not.toBeNull();
    await store.remove("1001", "processing");
    expect(await store.get("1001")).toBeNull();
    expect(await store.get("nope")).toBeNull();
  });
});

describe("the refunds migration", () => {
  it("rejects what the rule would never write", async () => {
    const db = await freshDb();
    const insert = (over: Record<string, unknown>) => {
      const row = {
        order_id: "1004",
        item: "Copper Home",
        amount_cents: 14900,
        currency: "USD",
        status: "pending",
        decided_by: null,
        limit_cents: 5000,
        ...over,
      };
      const keys = Object.keys(row);
      return db.query(
        `insert into refunds (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        Object.values(row),
      );
    };
    await expect(insert({ amount_cents: 0 })).rejects.toThrow();
    await expect(insert({ amount_cents: -5 })).rejects.toThrow();
    await expect(insert({ limit_cents: -1 })).rejects.toThrow();
    await expect(insert({ status: "approved" })).rejects.toThrow();
    await expect(insert({ currency: "dollars" })).rejects.toThrow();
    // Paid or rejected without anyone having decided it.
    await expect(insert({ status: "refunded" })).rejects.toThrow();
    // A limit of $0 is valid; a negative one is not.
    await db.query("update app_settings set value = 0");
    await expect(
      db.query("update app_settings set value = -1"),
    ).rejects.toThrow();
  });

  it("keeps one refund per order and turns on row-level security", async () => {
    const db = await freshDb();
    await db.exec(
      `insert into refunds (order_id, item, amount_cents, currency, status, limit_cents)
       values ('1004', 'Copper Home', 14900, 'USD', 'pending', 5000)`,
    );
    await expect(
      db.exec(
        `insert into refunds (order_id, item, amount_cents, currency, status, limit_cents)
         values ('1004', 'Copper Home', 14900, 'USD', 'pending', 5000)`,
      ),
    ).rejects.toThrow(/duplicate key/);
    const { rows } = await db.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      "select relname, relrowsecurity from pg_class where relname in ('refunds', 'app_settings')",
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
