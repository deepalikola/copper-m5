// The customer's orders (Module 4). Money is kept in whole cents with a
// currency, so comparisons never depend on floating-point dollars. The refund
// rule that uses these orders lives in lib/copper/refunds.ts.
import data from "@/lib/copper/data/orders.json";

export type Order = {
  id: string;
  item: string;
  /** What the customer paid, in cents of `currency`. */
  amountCents: number;
  currency: string;
  date: string;
};

export const CUSTOMER = data.customer;

/** The starting auto-refund limit on the Refund Console: $50. */
export const DEFAULT_LIMIT_CENTS = 5000;

/** The limit is set in this currency; orders in another one always wait for a person. */
export const LIMIT_CURRENCY = "USD";

const ORDERS: readonly Order[] = data.orders.map((order) => ({
  id: order.id,
  item: order.item,
  amountCents: Math.round(order.amountUsd * 100),
  currency: order.currency,
  date: order.date,
}));

export function getOrders(): Order[] {
  return ORDERS.map((order) => ({ ...order }));
}

/** An order number may come with a leading "#" and spaces, like "#1004". */
export function normalizeOrderId(input: unknown): string {
  return typeof input === "string" ? input.replace(/^\s*#?\s*/, "").trim() : "";
}

export function getOrder(input: unknown): Order | undefined {
  const id = normalizeOrderId(input);
  return getOrders().find((order) => order.id === id);
}

/** Cents as a display amount, like 7999 → "$79.99". */
export function formatMoney(cents: number, currency = LIMIT_CURRENCY): string {
  const amount = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}
