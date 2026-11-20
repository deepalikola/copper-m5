"use server";

// What the Refund Console can ask the server to do (Module 4). These are the
// only way a refund is approved or rejected, and the limit is checked here, so
// nothing in the chat can stand in for them. The app has no sign-in yet, so
// anyone who can open the console is treated as the supervisor; a production
// version would check the supervisor's identity at the top of each action.
import {
  type Decision,
  decideRefund,
  type Desk,
  getDesk,
  updateLimit,
} from "@/lib/copper/refunds";

export type ConsoleResult =
  | { ok: true; desk: Desk; orderId?: string }
  | { ok: false; error: string; desk?: Desk };

const TRY_AGAIN = "Something went wrong on our side. Please try again.";

async function guarded(
  run: () => Promise<ConsoleResult>,
): Promise<ConsoleResult> {
  try {
    return await run();
  } catch {
    return { ok: false, error: TRY_AGAIN };
  }
}

export async function loadDesk(): Promise<ConsoleResult> {
  return guarded(async () => ({ ok: true, desk: await getDesk() }));
}

export async function saveLimit(input: string): Promise<ConsoleResult> {
  return guarded(async () => {
    const parsed = await updateLimit(input);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, desk: await getDesk() };
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
    if (decision !== "approve" && decision !== "reject")
      return { ok: false, error: "Choose Approve or Reject." };
    const result = await decideRefund(orderId, decision);
    const desk = await getDesk();
    return result.ok
      ? { ok: true, desk, orderId: result.refund.orderId }
      : { ok: false, error: MESSAGES[result.error], desk };
  });
}
