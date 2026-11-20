// Langfuse tracing (Module 5): what the app records about each chat and AI
// call, and how it keeps customer data out of it. The helpers here are light
// and always safe to call: without Langfuse keys the tracer is a no-op and
// nothing leaves the server. lib/ai/tracing-setup.ts starts the exporter.
//
// What a chat turn records: the design that answered ("handoff" or "single"),
// which agent ran each step, every handoff, every tool call (name and timing),
// tokens, latency, errors, and the app's own cost estimate (lib/ai/pricing.ts).
//
// What it does NOT record: the customer's messages, the model's replies, tool
// inputs and tool results. Those can hold names, order numbers and amounts, so
// they stay out unless AI_TRACE_CONTENT=1, which only the evals set (their
// questions are made up).
import {
  startActiveObservation,
  startObservation,
  propagateAttributes,
} from "@langfuse/tracing";

export { startActiveObservation, startObservation, propagateAttributes };

type ProcessorHolder = {
  __copperLangfuseFlush?: () => Promise<void>;
};
const holder = globalThis as ProcessorHolder;

/** True when the three Langfuse variables are set. */
export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY &&
    process.env.LANGFUSE_SECRET_KEY &&
    process.env.LANGFUSE_BASE_URL,
  );
}

/** Whether prompts, replies and tool data go into traces. Off unless AI_TRACE_CONTENT=1. */
export function traceContentEnabled(): boolean {
  return process.env.AI_TRACE_CONTENT === "1";
}

export type TraceInfo = { module: number; feature: string; agent?: string };

/**
 * The `telemetry` and `runtimeContext` options for one AI call. Only these
 * three small labels go along with the call, and the content switches follow
 * traceContentEnabled().
 */
export function traceOptions(info: TraceInfo) {
  const content = traceContentEnabled();
  return {
    telemetry: {
      functionId: info.feature,
      recordInputs: content,
      recordOutputs: content,
      includeRuntimeContext: { module: true, feature: true, agent: true },
    },
    runtimeContext: {
      module: info.module,
      feature: info.feature,
      agent: info.agent ?? "none",
    },
  };
}

/** Registered by tracing-setup.ts so a serverless function can flush before it stops. */
export function setTraceFlusher(flush: () => Promise<void>) {
  holder.__copperLangfuseFlush = flush;
}

/** Sends any waiting spans to Langfuse. Does nothing when tracing isn't set up. */
export async function flushTraces(): Promise<void> {
  try {
    await holder.__copperLangfuseFlush?.();
  } catch {
    // Tracing must never break a chat.
  }
}
