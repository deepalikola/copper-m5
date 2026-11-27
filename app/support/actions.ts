"use server";

// What the Refund Console can ask the server to do (Module 4). These are the
// only way a refund is approved or rejected or the limit changed, and each one
// checks on the server that the caller is a signed-in supervisor
// (lib/copper/supervisor-auth.ts) before it does anything. The customer chat
// can't reach them: the Refund agent has no tool that calls them, and a
// customer using the page without signing in is turned away here.
//
// Server actions are public HTTP endpoints, so the check lives in each action,
// never only in the page that shows the buttons.
import {
  isSupervisor,
  isSupervisorAuthConfigured,
  NotAuthorizedError,
  requireSupervisor,
  signInSupervisor,
  signOutSupervisor,
} from "@/lib/copper/supervisor-auth";
import {
  type Decision,
  decideRefund,
  type DeskOrder,
  getDesk,
  updateLimit,
} from "@/lib/copper/refunds";

/** What the page shows. A customer sees orders and their refund status only. */
export type ConsoleView = {
  supervisor: boolean;
  /** False if the supervisor passcode isn't set up, so nobody can sign in. */
  signInAvailable: boolean;
  customer: string;
  orders: DeskOrder[];
  /** The auto-refund limit. Supervisors only. */
  limitCents?: number;
};

export type ConsoleResult =
  | { ok: true; view: ConsoleView; orderId?: string }
  | { ok: false; error: string; view?: ConsoleView };

const TRY_AGAIN = "Something went wrong on our side. Please try again.";
const NOT_AUTHORIZED = "Only a signed-in supervisor can do that.";

async function viewForCaller(): Promise<ConsoleView> {
  const [desk, supervisor] = await Promise.all([getDesk(), isSupervisor()]);
  return {
    supervisor,
    signInAvailable: isSupervisorAuthConfigured(),
    customer: desk.customer,
    // The limit and the limit each request was held against are the
    // supervisor's business; a customer would only learn how to game them.
    orders: supervisor
      ? desk.orders
      : desk.orders.map((order) => ({
          ...order,
          refund: order.refund && { ...order.refund, limitCents: 0 },
        })),
    ...(supervisor && { limitCents: desk.limitCents }),
  };
}

async function guarded(
  run: () => Promise<ConsoleResult>,
): Promise<ConsoleResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotAuthorizedError)
      return { ok: false, error: NOT_AUTHORIZED };
    return { ok: false, error: TRY_AGAIN };
  }
}

export async function loadDesk(): Promise<ConsoleResult> {
  return guarded(async () => ({ ok: true, view: await viewForCaller() }));
}

export async function signIn(passcode: string): Promise<ConsoleResult> {
  return guarded(async () => {
    const result = await signInSupervisor(passcode);
    const view = await viewForCaller();
    return result.ok
      ? { ok: true, view }
      : { ok: false, error: result.error, view };
  });
}

export async function signOut(): Promise<ConsoleResult> {
  return guarded(async () => {
    await signOutSupervisor();
    return {
      ok: true,
      view: { ...(await viewForCaller()), supervisor: false },
    };
  });
}

export async function saveLimit(input: string): Promise<ConsoleResult> {
  return guarded(async () => {
    await requireSupervisor();
    const parsed = await updateLimit(input);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, view: await viewForCaller() };
  });
}

const MESSAGES = {
  not_found: "There is no refund request for that order.",
  not_pending: "That request was already decided, so nothing changed.",
  payout_failed:
    "The payment didn't go through, so nothing was refunded. It is waiting again; try Approve once more.",
} as const;

export async function decide(
  orderId: string,
  decision: Decision,
): Promise<ConsoleResult> {
  return guarded(async () => {
    await requireSupervisor();
    if (decision !== "approve" && decision !== "reject")
      return { ok: false, error: "Choose Approve or Reject." };
    const result = await decideRefund(orderId, decision);
    const view = await viewForCaller();
    return result.ok
      ? { ok: true, view, orderId: result.refund.orderId }
      : { ok: false, error: MESSAGES[result.error], view };
  });
}
