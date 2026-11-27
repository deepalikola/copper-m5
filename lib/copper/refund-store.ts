// Where refunds and the auto-refund limit are kept (Module 4). The rule in
// lib/copper/refunds.ts only talks to this interface, which has two atomic
// steps everything else is built on:
//   - create: add a refund for an order, unless the order already has one
//   - transition: change a refund's status, but only from the status expected
// Supabase (production) and memory (local development and tests) both keep
// those two promises, so a repeated message, a retried tool call or two
// requests at once can't refund an order twice.
import { DEFAULT_LIMIT_CENTS } from "@/lib/copper/orders";
import { createRefundStoreClient } from "@/lib/supabase/admin";
import { createSupabaseRefundStore } from "@/lib/copper/refund-store-supabase";

/**
 * processing: being paid out right now. pending: over the limit, waiting for a
 * person. refunded and rejected are final.
 */
export type RefundStatus = "processing" | "pending" | "refunded" | "rejected";

export type Refund = {
  orderId: string;
  item: string;
  /** The order's recorded amount and currency when the refund was requested. */
  amountCents: number;
  currency: string;
  status: RefundStatus;
  /** auto: within the limit. supervisor: a person on the Refund Console. null: still waiting. */
  decidedBy: "auto" | "supervisor" | null;
  /** The limit in force when this was requested. Changing the limit later never changes it. */
  limitCents: number;
  requestedAt: string;
  decidedAt: string | null;
};

/** What `transition` can change. */
export type RefundPatch = Partial<
  Pick<Refund, "status" | "decidedBy" | "decidedAt">
>;

export type RefundStore = {
  getLimitCents(): Promise<number>;
  setLimitCents(cents: number): Promise<void>;
  list(): Promise<Refund[]>;
  get(orderId: string): Promise<Refund | null>;
  /** Adds the refund unless the order has one; returns the one that now stands. */
  create(refund: Refund): Promise<{ created: boolean; refund: Refund }>;
  /** Applies the patch only if the refund is in one of the `from` statuses. */
  transition(
    orderId: string,
    from: RefundStatus[],
    patch: RefundPatch,
  ): Promise<Refund | null>;
  /** Deletes the refund only if it is in `status` (undoes a failed payout). */
  remove(orderId: string, status: RefundStatus): Promise<void>;
};

/** Keeps everything in this server process. Used without Supabase, and in tests. */
export function createMemoryRefundStore(): RefundStore {
  let limitCents = DEFAULT_LIMIT_CENTS;
  const refunds = new Map<string, Refund>();
  // Each method checks and changes the map with no `await` in between, so two
  // requests at once can't both pass a check: JavaScript runs one at a time.
  return {
    async getLimitCents() {
      return limitCents;
    },
    async setLimitCents(cents) {
      limitCents = cents;
    },
    async list() {
      return [...refunds.values()].map((r) => ({ ...r }));
    },
    async get(orderId) {
      const refund = refunds.get(orderId);
      return refund ? { ...refund } : null;
    },
    async create(refund) {
      const earlier = refunds.get(refund.orderId);
      if (earlier) return { created: false, refund: { ...earlier } };
      refunds.set(refund.orderId, { ...refund });
      return { created: true, refund: { ...refund } };
    },
    async transition(orderId, from, patch) {
      const refund = refunds.get(orderId);
      if (!refund || !from.includes(refund.status)) return null;
      Object.assign(refund, patch);
      return { ...refund };
    },
    async remove(orderId, status) {
      if (refunds.get(orderId)?.status === status) refunds.delete(orderId);
    },
  };
}

// Kept on globalThis so Next's dev reloads don't wipe the refunds.
const globalStore = globalThis as { __copperRefundStore?: RefundStore };

/** "supabase" when the server-side Supabase keys are set, otherwise "memory". */
export function refundStorage(): "supabase" | "memory" {
  return createRefundStoreClient() ? "supabase" : "memory";
}

/**
 * Refunds must survive restarts and be shared by every server instance, so a
 * production deployment needs Supabase. Memory is for local development.
 */
export function isRefundStorageReady(): boolean {
  return (
    refundStorage() === "supabase" || process.env.NODE_ENV !== "production"
  );
}

export function getRefundStore(): RefundStore {
  const client = createRefundStoreClient();
  if (client) return createSupabaseRefundStore(client);
  return (globalStore.__copperRefundStore ??= createMemoryRefundStore());
}

/** Empties the in-memory store. For tests and the local demo. */
export function resetMemoryRefundStore(): void {
  globalStore.__copperRefundStore = createMemoryRefundStore();
}
