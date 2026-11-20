"use client";

// The Refund Console (Module 4): the auto-refund limit, the refunds waiting
// for a person, and the customer's orders, with Ask Copper docked beside it.
// Everything on this page is read from the server. The Refund agent asks the
// app for a refund; the app decides against the limit; refunds over it wait
// here until you approve or reject them, and the Refund agent then tells the
// customer what the server recorded.
import { useCallback, useEffect, useRef, useState } from "react";
import { decide, loadDesk, saveLimit } from "@/app/support/actions";
import { AskCopper } from "@/components/copper/ask-copper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/copper/orders";
import type { Desk } from "@/lib/copper/refunds";
import type { Refund } from "@/lib/copper/refund-store";

const STARTERS = [
  "I'd like a refund for my Copper Plus monthly plan.",
  "I want my money back for my Copper Home.",
  "What does the refund policy say about annual plans?",
];

const REFRESH_MS = 4000;

function statusBadge(refund: Refund | null) {
  if (!refund) return { label: "Paid", className: "", outline: true };
  if (refund.status === "refunded")
    return {
      label:
        refund.decidedBy === "supervisor"
          ? "Refunded, approved by you"
          : "Refunded automatically",
      className: "bg-accent text-white",
    };
  if (refund.status === "pending")
    return {
      label: "Waiting for approval",
      className: "bg-chart-3 text-white",
    };
  if (refund.status === "rejected")
    return {
      label: "Rejected by you",
      className: "bg-muted-foreground text-white",
    };
  return { label: "Processing refund", className: "bg-chart-3 text-white" };
}

export function RefundConsole({
  aiConfigured,
  storage = "supabase",
}: {
  aiConfigured: boolean;
  /** memory: refunds are lost when the server restarts (local development). */
  storage?: "supabase" | "memory";
}) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [limit, setLimit] = useState("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<{ id: number; text: string } | null>(null);
  const editingLimit = useRef(false);

  const show = useCallback((next?: Desk) => {
    if (!next) return;
    setDesk(next);
    if (!editingLimit.current) setLimit(String(next.limitCents / 100));
  }, []);

  const refresh = useCallback(async () => {
    const result = await loadDesk();
    if (result.ok) show(result.desk);
    else setMessage(result.error);
  }, [show]);

  useEffect(() => {
    // Load now, then keep checking: the chat can add a request any time.
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  async function onSaveLimit() {
    setLimitError(null);
    const result = await saveLimit(limit);
    if (result.ok) {
      editingLimit.current = false;
      show(result.desk);
    } else setLimitError(result.error);
  }

  /** Your decision on a waiting refund. The chat then tells the Refund agent. */
  async function onDecide(refund: Refund, decision: "approve" | "reject") {
    // One click at a time per order; the server also ignores a repeat.
    if (busy.has(refund.orderId)) return;
    setBusy((all) => new Set(all).add(refund.orderId));
    setMessage(null);
    const result = await decide(refund.orderId, decision);
    show(result.desk);
    if (result.ok)
      setNote((last) => ({
        id: (last?.id ?? 0) + 1,
        text: `[Refund Console] A decision was recorded for order #${refund.orderId}. Look up the order and tell the customer exactly what its status shows.`,
      }));
    else setMessage(result.error);
    setBusy((all) => {
      const next = new Set(all);
      next.delete(refund.orderId);
      return next;
    });
  }

  const waiting = desk?.orders.flatMap((o) =>
    o.refund?.status === "pending" ? [o.refund] : [],
  );
  const limitCents = desk?.limitCents ?? 0;

  return (
    <>
      <main
        data-testid="refund-console"
        className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-4 py-8"
      >
        <div>
          <h1 className="font-display text-3xl font-bold">Refund Console</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Ask for a refund in the chat as the customer. Copper hands you to
            the Refund agent, which asks the app for the refund. The app checks
            the order&apos;s amount against your limit: at or under it, the
            refund goes through; over it, it waits here for you.
          </p>
          {storage === "memory" && (
            <p
              role="status"
              className="bg-secondary text-secondary-foreground mt-3 rounded-lg px-3 py-2 text-xs"
            >
              Local mode: refunds are kept in memory and reset when the server
              restarts. Add the Supabase keys to keep them.
            </p>
          )}
        </div>

        <section className="bg-card space-y-2 rounded-xl border p-4">
          <Label htmlFor="refund-limit" className="font-semibold">
            Auto-refund limit
          </Label>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void onSaveLimit();
            }}
          >
            <span className="text-muted-foreground">$</span>
            <Input
              id="refund-limit"
              type="text"
              inputMode="decimal"
              value={limit}
              aria-invalid={limitError ? true : undefined}
              aria-describedby="refund-limit-help"
              onChange={(event) => {
                editingLimit.current = true;
                setLimit(event.target.value);
              }}
              className="w-32"
            />
            <Button type="submit" variant="outline">
              Save limit
            </Button>
          </form>
          {limitError && (
            <p role="alert" className="text-destructive text-xs">
              {limitError}
            </p>
          )}
          <p id="refund-limit-help" className="text-muted-foreground text-xs">
            {limitCents === 0
              ? "With a limit of $0, every refund needs your approval."
              : `Refunds up to ${formatMoney(limitCents)} go through on their own. Anything larger needs your approval.`}{" "}
            Changing the limit never changes a request that is already waiting:
            only you decide those.
          </p>
        </section>

        {message && (
          <p role="alert" className="text-destructive text-sm">
            {message}
          </p>
        )}

        <section className="space-y-3">
          <h2 className="font-semibold">Waiting for your approval</h2>
          {waiting?.length === 0 && (
            <p className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm">
              Nothing is waiting. Refunds over the limit will stop here.
            </p>
          )}
          {waiting?.map((refund) => (
            <div
              key={refund.orderId}
              data-testid="waiting-refund"
              className="border-chart-3 bg-card flex flex-wrap items-center gap-3 rounded-xl border-2 p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  #{refund.orderId} {refund.item}
                </p>
                <p className="text-muted-foreground text-xs">
                  {formatMoney(refund.amountCents, refund.currency)} was over
                  the {formatMoney(refund.limitCents)} limit when it was asked
                  for. The Refund agent is paused.
                </p>
              </div>
              <span className="font-mono text-lg font-bold">
                {formatMoney(refund.amountCents, refund.currency)}
              </span>
              <Button
                disabled={busy.has(refund.orderId)}
                onClick={() => void onDecide(refund, "approve")}
              >
                Approve
              </Button>
              <Button
                variant="outline"
                disabled={busy.has(refund.orderId)}
                onClick={() => void onDecide(refund, "reject")}
              >
                Reject
              </Button>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="font-semibold">{desk?.customer}&apos;s orders</h2>
          <ul className="bg-card divide-y rounded-xl border text-sm">
            {desk?.orders.map((order) => {
              const status = statusBadge(order.refund);
              return (
                <li
                  key={order.id}
                  data-testid="order"
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <span className="text-muted-foreground font-mono">
                    #{order.id}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">
                    {order.item}
                  </span>
                  <Badge
                    variant={status.outline ? "outline" : undefined}
                    className={status.className}
                  >
                    {status.label}
                  </Badge>
                  <span className="w-16 text-right font-mono">
                    {formatMoney(order.amountCents, order.currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </main>
      <AskCopper
        aiConfigured={aiConfigured}
        docked
        support={{ onDecision: refresh, note, starters: STARTERS }}
      />
    </>
  );
}
