// Plays one golden case through the app's real code: askCopper, with the real
// tools and the real refund rule, on a fresh in-memory refund store, so cases
// never affect each other or a real database. Only the model is real.
import { onAiCall } from "@/lib/ai/call";
import {
  askCopper,
  type ChatMessage,
  type Design,
} from "@/lib/copper/assistant/ask";
import { finalValue } from "@/lib/ai/live";
import type { Agent } from "@/lib/copper/assistant/progress";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { getOrder } from "@/lib/copper/orders";
import { createMemoryRefundStore } from "@/lib/copper/refund-store";
import { configureRefunds, type Payout } from "@/lib/copper/refunds";
import { type GoldenCase, type GoldenSet } from "./golden";
import { type CaseRun, defaultLimit } from "./score";

/** The agents' own runs (each can take several model steps); the judge's calls are left out. */
const isAgentCall = (feature: string) => feature !== "judge";

export async function runCase(
  set: GoldenSet,
  c: GoldenCase,
  design: Design,
): Promise<CaseRun> {
  const store = createMemoryRefundStore();
  let payouts = 0;
  const payout: Payout = async () => {
    payouts++;
  };
  configureRefunds({ store, payout });
  await store.setLimitCents(Math.round(defaultLimit(set, c) * 100));
  for (const seeded of c.setup?.refunds ?? []) {
    const order = getOrder(seeded.orderId);
    if (!order)
      throw new Error(`Golden case ${c.id}: no order ${seeded.orderId}`);
    await store.create({
      orderId: order.id,
      item: order.item,
      amountCents: order.amountCents,
      currency: order.currency,
      status: seeded.status,
      decidedBy: seeded.status === "pending" ? null : "supervisor",
      limitCents: Math.round(defaultLimit(set, c) * 100),
      requestedAt: new Date().toISOString(),
      decidedAt: seeded.status === "pending" ? null : new Date().toISOString(),
    });
    // A seeded paid refund counts as already paid out.
    if (seeded.status === "refunded") payouts++;
  }

  let agentRuns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costKnown = true;
  let costUsd = 0;
  const stopListening = onAiCall((row) => {
    if (!isAgentCall(row.feature)) return;
    agentRuns++;
    inputTokens += row.input_tokens ?? 0;
    outputTokens += row.output_tokens ?? 0;
    if (row.cost_usd === null) costKnown = false;
    else costUsd += row.cost_usd;
  });

  const messages: ChatMessage[] = [];
  const replies: string[] = [];
  const toolCalls: CaseRun["toolCalls"] = [];
  let handoffs = 0;
  let errored = false;
  let agent: Agent | undefined;
  const started = performance.now();
  try {
    for (const turn of c.turns) {
      messages.push({ role: "user", content: turn });
      const progress = await finalValue(
        (
          await askCopper({
            messages,
            useTools: true,
            support: true,
            design,
            agent,
          })
        ).progress,
      );
      errored ||= progress.status === "error";
      toolCalls.push(...toolCallsOf(progress));
      handoffs += progress.steps.filter((s) => s.type === "handoff").length;
      replies.push(progress.reply);
      messages.push({ role: "assistant", content: progress.reply });
      agent = progress.agent;
    }
  } finally {
    stopListening();
  }
  const latencyMs = Math.round(performance.now() - started);

  return {
    caseId: c.id,
    design,
    reply: replies.at(-1) ?? "",
    replies,
    toolCalls,
    handoffs,
    errored,
    refunds: Object.fromEntries(
      (await store.list()).map((r) => [
        r.orderId,
        {
          status: r.status,
          decidedBy: r.decidedBy,
          amountCents: r.amountCents,
          limitCents: r.limitCents,
        },
      ]),
    ),
    payouts,
    latencyMs,
    agentRuns,
    inputTokens,
    outputTokens,
    costUsd: costKnown ? costUsd : null,
  };
}
