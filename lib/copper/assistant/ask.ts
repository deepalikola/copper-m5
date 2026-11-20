"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: on the Support page the chat also says so, and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too. The
// refunds and the auto-refund limit live on the server, never in the request.
// Module 5: `design: "single"` swaps the two agents for one agent with every
// tool and no handoff, to compare the designs. Each chat turn is one Langfuse
// trace, with one span per agent run (lib/ai/tracing.ts).
import { hasToolCall, stepCountIs } from "ai";
import { after } from "next/server";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { defaultModel } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import {
  flushTraces,
  propagateAttributes,
  startActiveObservation,
  startObservation,
} from "@/lib/ai/tracing";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  SINGLE_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import type {
  Agent,
  Progress,
  ToolStep,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundAgentTools,
  singleAgentTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** handoff: Copper and the Refund agent. single: one agent with every tool. */
export type Design = "handoff" | "single";

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** On the Support page, where Copper can hand refunds to the Refund agent. */
  support?: boolean;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
  /** Which support design answers on the Support page. Handoff by default. */
  design?: Design;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** One agent's call: its instructions and only its own tools. */
function agentCall(agent: Agent, messages: ChatMessage[], support?: boolean) {
  if (agent === "single" && support)
    return callStream(
      { module: 5, feature: "single-agent", agent: "single" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: SINGLE_AGENT_INSTRUCTIONS,
        tools: singleAgentTools(),
        // No handoff tools here, so only the step limit ends its turn.
        stopWhen: stepCountIs(MAX_STEPS),
      },
    );
  if (agent === "refund" && support)
    return callStream(
      { module: 4, feature: "refund-agent", agent: "refund" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: REFUND_AGENT_INSTRUCTIONS,
        tools: refundAgentTools(),
        stopWhen: STOP,
      },
    );
  return callStream(
    { module: 2, feature: "ask-copper", agent: "copper" },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: support
        ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
        : COPPER_INSTRUCTIONS,
      tools: support
        ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
        : copperTools,
      stopWhen: STOP,
    },
  );
}

export async function askCopper({
  messages,
  useTools,
  support,
  agent = "copper",
  design = "handoff",
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  // "single" belongs to the single design only: under the handoff design a
  // leftover "single" from an earlier turn starts with Copper instead.
  const first: Agent =
    support && useTools
      ? design === "single"
        ? "single"
        : agent === "single"
          ? "copper"
          : agent
      : "copper";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /** Reads one agent's stream into progress. Returns who to hand off to. */
  async function follow(
    current: Agent,
    result: ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking" && last.agent === current)
            last.text += part.text;
          else
            progress.steps.push({
              type: "thinking",
              text: part.text,
              agent: current,
            });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: `${call}:${part.id}`,
            agent: current,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.toolCallId}`,
              agent: current,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName in HANDOFF_TOOLS)
            handoff = HANDOFF_TOOLS[part.toolName];
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handoff;
  }

  /**
   * One agent's run as a Langfuse span: the model call and its tool calls are
   * its children. The span also records tokens and the app's cost estimate.
   */
  function runAgent(
    current: Agent,
    start: () => ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    return startActiveObservation(
      `agent:${current}`,
      async (span) => {
        span.update({ metadata: { agent: current, design } });
        const result = start();
        const handoff = await follow(current, result);
        const usage = await result.totalUsage.then(
          (u) => u,
          () => undefined,
        );
        const input = usage?.inputTokens;
        const output = usage?.outputTokens;
        span.update({
          metadata: {
            agent: current,
            design,
            inputTokens: input ?? null,
            outputTokens: output ?? null,
            costUsd:
              input != null && output != null
                ? costUsd(defaultModel(), input, output)
                : null,
            handoffTo: handoff ?? null,
          },
        });
        return handoff;
      },
      { asType: "agent" },
    );
  }

  // Read the stream in the background, so the panel gets the first update now.
  const finished = propagateAttributes(
    { traceName: "ask-copper-turn", tags: [design], metadata: { design } },
    () =>
      startActiveObservation("ask-copper-turn", async (turn) => {
        try {
          if (!useTools) {
            // Without tools, send no instructions either: "always use your
            // tools" with no tools makes the model answer with nothing.
            await runAgent("copper", () =>
              callStream(
                { module: 2, feature: "ask-copper", agent: "copper" },
                { messages, providerOptions: THOUGHT_SUMMARIES },
              ),
            );
          } else {
            let current = first;
            for (let handoffs = 0; ; handoffs++) {
              const next = await runAgent(current, () =>
                agentCall(current, messages, support),
              );
              if (!next || next === current || handoffs >= MAX_HANDOFFS) break;
              startObservation(
                "handoff",
                { metadata: { from: current, to: next } },
                { asType: "event" },
              );
              progress.steps.push({ type: "handoff", from: current, to: next });
              progress.agent = current = next;
              progress.reply = "";
              call++;
              update(snapshot());
            }
          }
          progress.status = "done";
          if (!progress.reply.trim()) progress.reply = SORRY;
        } catch {
          progress.status = "error";
          if (!progress.reply.trim()) progress.reply = SORRY;
          // The error text is left out: it could echo what the customer typed.
          turn.update({ level: "ERROR", statusMessage: "chat turn failed" });
        }
        done(snapshot());
      }),
  );

  // On a server, send the trace to Langfuse before the function stops.
  const flush = () => finished.then(flushTraces, flushTraces);
  try {
    after(flush);
  } catch {
    // Not inside a request (tests, evals): flush when the turn ends.
    void flush();
  }

  return { progress: live };
}
