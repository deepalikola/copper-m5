// @vitest-environment node
// Langfuse tracing (Module 5), checked with real OpenTelemetry spans kept in
// memory instead of sent to Langfuse: which agent ran, the handoff, the tool
// calls, tokens and errors are recorded, and customer text is not.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { finalValue } from "@/lib/ai/live";
import {
  flushTraces,
  isTracingConfigured,
  setTraceFlusher,
  traceContentEnabled,
  traceOptions,
} from "@/lib/ai/tracing";
import { createMemoryRefundStore } from "@/lib/copper/refund-store";
import { configureRefunds } from "@/lib/copper/refunds";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  // register() installs the context manager NodeSDK installs in production, so
  // child spans find their parent.
  provider.register();
  setLangfuseTracerProvider(provider);
  registerTelemetry(
    new LangfuseVercelAiSdkIntegration({
      tracer: provider.getTracer("test"),
    }),
  );
});

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];
function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

async function ask(
  request: Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0],
) {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  const result = await finalValue((await askCopper(request)).progress);
  await provider.forceFlush();
  return result;
}

const names = () => exporter.getFinishedSpans().map((s) => s.name);
const spanNamed = (name: string) =>
  exporter.getFinishedSpans().find((s) => s.name === name);
const allAttributes = () =>
  JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes));

beforeEach(() => {
  exporter.reset();
  configureRefunds({ store: createMemoryRefundStore() });
});
afterEach(() => vi.unstubAllEnvs());

/** An observation's metadata. Langfuse stores each value as JSON text. */
const meta = (name: string) => {
  const prefix = "langfuse.observation.metadata.";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spanNamed(name)?.attributes ?? {}))
    if (key.startsWith(prefix))
      out[key.slice(prefix.length)] =
        typeof value === "string" ? JSON.parse(value) : value;
  return out;
};

const MARKER = "MARKER-9137";

async function refundTurn(design: "handoff" | "single" = "handoff") {
  model =
    design === "handoff"
      ? modelStreaming(
          calls("transfer_to_refund_agent", { reason: "refund" }),
          calls("request_refund", { orderId: "1004" }),
          says("A supervisor needs to approve it."),
        )
      : modelStreaming(
          calls("request_refund", { orderId: "1004" }),
          says("A supervisor needs to approve it."),
        );
  return ask({
    messages: [{ role: "user", content: `Refund order 1004 ${MARKER}` }],
    useTools: true,
    support: true,
    design,
  });
}

describe("what a chat turn records (handoff design)", () => {
  it("records the turn, each agent, the handoff and the tool calls", async () => {
    await refundTurn();
    expect(names()).toEqual(
      expect.arrayContaining([
        "ask-copper-turn",
        "agent:copper",
        "handoff",
        "agent:refund",
        "execute_tool transfer_to_refund_agent",
        "execute_tool request_refund",
      ]),
    );
    expect(meta("handoff")).toEqual({ from: "copper", to: "refund" });
    // The agents' spans hang under the turn's span, in one trace.
    const turn = spanNamed("ask-copper-turn")!;
    for (const name of ["agent:copper", "agent:refund", "handoff"]) {
      const span = spanNamed(name)!;
      expect(span.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
      expect(span.spanContext().traceId).toBe(turn.spanContext().traceId);
    }
  });

  it("says which agent answered, and records tokens and the cost estimate for each", async () => {
    await refundTurn();
    expect(meta("agent:copper")).toMatchObject({
      agent: "copper",
      design: "handoff",
      handoffTo: "refund",
      inputTokens: 500,
      outputTokens: 50,
    });
    expect(meta("agent:refund")).toMatchObject({
      agent: "refund",
      design: "handoff",
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(meta("agent:refund")).not.toHaveProperty("handoffTo");
    // $0.30 / $2.50 per million tokens for the default model.
    expect(meta("agent:refund").costUsd).toBeCloseTo(0.00055, 8);
    // The model calls carry their own usage and the agent that made them.
    const calls = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect(calls).toHaveLength(3);
    expect(calls.map((s) => s.attributes["gen_ai.usage.input_tokens"])).toEqual(
      [500, 500, 500],
    );
    expect(
      calls.map((s) => s.attributes["langfuse.observation.metadata.agent"]),
    ).toEqual(['"copper"', '"refund"', '"refund"']);
    // Latency is the span's own start and end.
    for (const span of exporter.getFinishedSpans())
      expect(span.endTime[0] * 1e9 + span.endTime[1]).toBeGreaterThanOrEqual(
        span.startTime[0] * 1e9 + span.startTime[1],
      );
  });
});

describe("what a chat turn records (single design)", () => {
  it("one agent span, no handoff, the same tool", async () => {
    await refundTurn("single");
    expect(names()).toEqual(
      expect.arrayContaining([
        "ask-copper-turn",
        "agent:single",
        "execute_tool request_refund",
      ]),
    );
    expect(names()).not.toContain("handoff");
    expect(names()).not.toContain("agent:refund");
    expect(meta("agent:single")).toMatchObject({
      agent: "single",
      design: "single",
      inputTokens: 1000,
    });
    expect(meta("agent:single")).not.toHaveProperty("handoffTo");
  });
});

describe("customer data stays out of traces", () => {
  it("leaves out what the customer typed, tool inputs and results, by default", async () => {
    await refundTurn();
    expect(allAttributes()).not.toContain(MARKER);
    expect(allAttributes()).not.toContain("1004");
    expect(allAttributes()).not.toContain("Copper Home");
    expect(allAttributes()).not.toContain("supervisor needs to approve");
  });

  it("records content only when AI_TRACE_CONTENT=1, as the evals do", async () => {
    vi.stubEnv("AI_TRACE_CONTENT", "1");
    await refundTurn();
    expect(allAttributes()).toContain(MARKER);
  });

  it("sends only the module, feature and agent as context", () => {
    expect(
      traceOptions({ module: 4, feature: "refund-agent", agent: "refund" }),
    ).toEqual({
      telemetry: {
        functionId: "refund-agent",
        recordInputs: false,
        recordOutputs: false,
        includeRuntimeContext: { module: true, feature: true, agent: true },
      },
      runtimeContext: { module: 4, feature: "refund-agent", agent: "refund" },
    });
  });
});

describe("errors", () => {
  it("marks the turn as an error without copying the error text", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error(`boom with customer text ${MARKER}`);
      },
    });
    const result = await ask({
      messages: [{ role: "user", content: "Hello" }],
      useTools: true,
    });
    expect(result.status).toBe("error");
    const turn = spanNamed("ask-copper-turn")!;
    expect(turn.attributes["langfuse.observation.level"]).toBe("ERROR");
    expect(allAttributes()).not.toContain(MARKER);
  });
});

describe("setup", () => {
  it("is off until all three Langfuse variables are set", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    expect(isTracingConfigured()).toBe(false);
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
    expect(isTracingConfigured()).toBe(false);
    vi.stubEnv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com");
    expect(isTracingConfigured()).toBe(true);
  });

  it("keeps content off unless AI_TRACE_CONTENT is exactly 1", () => {
    for (const value of ["", "0", "true", "yes"]) {
      vi.stubEnv("AI_TRACE_CONTENT", value);
      expect(traceContentEnabled()).toBe(false);
    }
    vi.stubEnv("AI_TRACE_CONTENT", "1");
    expect(traceContentEnabled()).toBe(true);
  });

  it("flushing never breaks a chat, even if Langfuse is unreachable", async () => {
    const flush = vi.fn().mockRejectedValue(new Error("network down"));
    setTraceFlusher(flush);
    await expect(flushTraces()).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
