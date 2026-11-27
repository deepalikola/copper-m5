// The refund rule (Module 4). It is code, not the model: the app compares the
// order's recorded amount and currency with the auto-refund limit. At or under
// the limit the refund is paid out; over it, a pending request waits until a
// person on the Refund Console approves or rejects it. Nothing a customer types
// reaches this decision: the Refund agent can only call requestRefund, and
// approving or rejecting is a separate server action behind the console.
//
// Assumptions, so they aren't a surprise:
//  - Eligible = the order exists, was a charge (amount above zero) and has no
//    refund yet. Return windows are policy text (Copper searches the customer
//    documents for them); the code doesn't enforce a date cut-off.
//  - The limit applies to one order's total, in US dollars. An order in another
//    currency always waits for a person.
//  - A limit of $0 is allowed: every refund then needs a person.
//  - A pending request stays pending when the limit changes, in both
//    directions, and only a person's decision settles it.
import {
  CUSTOMER,
  type Order,
  getOrder,
  getOrders,
  LIMIT_CURRENCY,
  normalizeOrderId,
} from "@/lib/copper/orders";
import {
  getRefundStore,
  type Refund,
  type RefundStore,
} from "@/lib/copper/refund-store";

/** The biggest limit the console accepts: $1,000,000. */
export const MAX_LIMIT_CENTS = 100_000_000;

export type LimitParse =
  { ok: true; cents: number } | { ok: false; error: string };

/**
 * Turns what a person typed (dollars, like "50" or "12.50") into cents.
 * Zero is fine; negative, blank, non-numeric, infinite or more-than-cents
 * values are not.
 */
export function parseLimit(input: unknown): LimitParse {
  if (typeof input === "number") input = String(input);
  if (typeof input !== "string")
    return { ok: false, error: "Enter the limit as a number of dollars." };
  const text = input.trim();
  if (text === "")
    return { ok: false, error: "Enter a limit, even if it is 0." };
  if (text.startsWith("-"))
    return { ok: false, error: "The limit can't be negative." };
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    return {
      ok: false,
      error: "Use a plain amount in dollars and cents, like 50 or 12.50.",
    };
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents > MAX_LIMIT_CENTS)
    return { ok: false, error: "That limit is too large." };
  return { ok: true, cents };
}

/** auto: paid out now. approval: waits for a person. */
export function routeRefund(order: Order, limitCents: number) {
  if (order.currency !== LIMIT_CURRENCY) return "approval";
  return order.amountCents <= limitCents ? "auto" : "approval";
}

/** Pays the money back. Throws if the payment can't go through. */
export type Payout = (refund: Refund) => Promise<void>;

/**
 * The course app has no payment provider, so a payout always succeeds. With a
 * real one, send `refund.orderId` as the idempotency key so a retry never pays
 * twice.
 */
export const simulatedPayout: Payout = async () => {};

type Deps = { store: RefundStore; payout: Payout };

// On globalThis, like the memory store, so it survives Next's dev reloads.
const shared = globalThis as { __copperRefundDeps?: Partial<Deps> };

const deps = (): Deps => ({
  store: shared.__copperRefundDeps?.store ?? getRefundStore(),
  payout: shared.__copperRefundDeps?.payout ?? simulatedPayout,
});

/** Swaps the store or the payout. For tests. */
export function configureRefunds(next: Partial<Deps>) {
  shared.__copperRefundDeps = next;
}

export type RefundResult =
  | { status: "not_found"; orderId: string }
  | { status: "not_eligible"; orderId: string; reason: string }
  | {
      /** An earlier request stands: waiting for a person, refunded, rejected or being paid. */
      status: "waiting" | "refunded" | "rejected" | "processing";
      alreadyRequested: true;
      orderId: string;
      item: string;
      amountUsd: number;
      currency: string;
    }
  | {
      /** refunded: paid now. needs_approval: waits for a person. payout_failed: nothing was refunded. */
      status: "refunded" | "needs_approval" | "payout_failed";
      orderId: string;
      item: string;
      amountUsd: number;
      currency: string;
      limitUsd: number;
    };

const dollars = (cents: number) => cents / 100;

const STATUS_NAME = {
  pending: "waiting",
  refunded: "refunded",
  rejected: "rejected",
  processing: "processing",
} as const;

/** request_refund: what the Refund agent's tool calls. The app decides. */
export async function requestRefund(orderId: unknown): Promise<RefundResult> {
  const { store, payout } = deps();
  const id = normalizeOrderId(orderId);
  const order = getOrder(id);
  if (!order) return { status: "not_found", orderId: id.slice(0, 40) };
  if (order.amountCents <= 0)
    return {
      status: "not_eligible",
      orderId: id,
      reason: "There was no charge on this order.",
    };

  const limitCents = await store.getLimitCents();
  const auto = routeRefund(order, limitCents) === "auto";
  const requestedAt = new Date().toISOString();
  const { created, refund } = await store.create({
    orderId: order.id,
    item: order.item,
    amountCents: order.amountCents,
    currency: order.currency,
    status: auto ? "processing" : "pending",
    decidedBy: auto ? "auto" : null,
    limitCents,
    requestedAt,
    decidedAt: null,
  });
  const summary = {
    orderId: order.id,
    item: order.item,
    amountUsd: dollars(order.amountCents),
    currency: order.currency,
  };
  // A repeat (same message again, a retried tool call, another request at the
  // same moment): the earlier request stands, and nothing is paid twice.
  if (!created)
    return {
      status: STATUS_NAME[refund.status],
      alreadyRequested: true,
      ...summary,
    };
  const limitUsd = dollars(limitCents);
  if (!auto) return { status: "needs_approval", ...summary, limitUsd };

  try {
    await payout(refund);
  } catch {
    // Nothing was paid, so take the request back: the customer can ask again.
    await store.remove(order.id, "processing");
    return { status: "payout_failed", ...summary, limitUsd };
  }
  await store.transition(order.id, ["processing"], {
    status: "refunded",
    decidedAt: new Date().toISOString(),
  });
  return { status: "refunded", ...summary, limitUsd };
}

export type Decision = "approve" | "reject";

export type DecisionResult =
  | { ok: true; refund: Refund }
  | {
      ok: false;
      /**
       * not_found: no request for that order. not_pending: it was already
       * decided (or is being paid), so nothing changed. payout_failed: the
       * approval is undone and the request is waiting again.
       */
      error: "not_found" | "not_pending" | "payout_failed";
      refund: Refund | null;
    };

/**
 * A person's decision from the Refund Console. Only a pending request can be
 * decided, once: the status change is atomic, so a second click, or two at the
 * same moment, changes nothing.
 */
export async function decideRefund(
  orderId: unknown,
  decision: Decision,
): Promise<DecisionResult> {
  const { store, payout } = deps();
  const id = normalizeOrderId(orderId);
  const earlier = await store.get(id);
  if (!earlier) return { ok: false, error: "not_found", refund: null };

  if (decision === "reject") {
    const rejected = await store.transition(id, ["pending"], {
      status: "rejected",
      decidedBy: "supervisor",
      decidedAt: new Date().toISOString(),
    });
    return rejected
      ? { ok: true, refund: rejected }
      : { ok: false, error: "not_pending", refund: await store.get(id) };
  }

  const claimed = await store.transition(id, ["pending"], {
    status: "processing",
    decidedBy: "supervisor",
  });
  if (!claimed)
    return { ok: false, error: "not_pending", refund: await store.get(id) };
  try {
    await payout(claimed);
  } catch {
    // Nothing was paid: put it back to waiting, so it can be approved again.
    const reverted = await store.transition(id, ["processing"], {
      status: "pending",
      decidedBy: null,
    });
    return { ok: false, error: "payout_failed", refund: reverted };
  }
  const refunded = await store.transition(id, ["processing"], {
    status: "refunded",
    decidedAt: new Date().toISOString(),
  });
  return { ok: true, refund: refunded ?? { ...claimed, status: "refunded" } };
}

export type DeskOrder = Order & { refund: Refund | null };

/** What the Refund Console shows: the limit and every order with its refund. */
export type Desk = {
  customer: string;
  limitCents: number;
  orders: DeskOrder[];
};

export async function getDesk(): Promise<Desk> {
  const { store } = deps();
  const [limitCents, refunds] = await Promise.all([
    store.getLimitCents(),
    store.list(),
  ]);
  return {
    customer: CUSTOMER,
    limitCents,
    orders: getOrders().map((order) => ({
      ...order,
      refund: refunds.find((r) => r.orderId === order.id) ?? null,
    })),
  };
}

/** Saves a new limit. Requests already waiting stay waiting. */
export async function updateLimit(input: unknown): Promise<LimitParse> {
  const parsed = parseLimit(input);
  if (parsed.ok) await deps().store.setLimitCents(parsed.cents);
  return parsed;
}

/** get_orders: the customer's orders, each with its refund so far. */
export async function ordersWithRefunds() {
  const desk = await getDesk();
  return {
    customer: desk.customer,
    orders: desk.orders.map((order) => ({
      id: order.id,
      item: order.item,
      amountUsd: dollars(order.amountCents),
      currency: order.currency,
      date: order.date,
      refund: order.refund ? STATUS_NAME[order.refund.status] : "none",
    })),
  };
}
