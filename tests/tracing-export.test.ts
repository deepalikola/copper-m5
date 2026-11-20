// @vitest-environment node
// What actually leaves the server. This starts the real Langfuse exporter
// (lib/ai/tracing-setup.ts) against a throwaway local HTTP server instead of
// Langfuse, runs a refund chat, and inspects the request: it goes to Langfuse's
// OpenTelemetry endpoint with the project's keys as Basic auth, it carries the
// agent, handoff and tool spans, and it contains none of the customer's text.
// It can't show that Langfuse itself accepts the data: that needs real keys.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { flushTraces } from "@/lib/ai/tracing";
import { startTracing } from "@/lib/ai/tracing-setup";
import { createMemoryRefundStore } from "@/lib/copper/refund-store";
import { configureRefunds } from "@/lib/copper/refunds";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type Received = { url: string; auth: string; encoding: string; body: Buffer };
const received: Received[] = [];
const server = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    received.push({
      url: req.url ?? "",
      auth: String(req.headers.authorization ?? ""),
      encoding: String(req.headers["content-encoding"] ?? ""),
      body: Buffer.concat(chunks),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});
afterAll(() => server.close());

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): ModelStreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const calls = (toolName: string, input: unknown): ModelStreamPart[] => [
  { type: "tool-input-start", id: "c1", toolName },
  { type: "tool-input-end", id: "c1" },
  {
    type: "tool-call",
    toolCallId: "c1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];
const says = (text: string): ModelStreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

describe("the Langfuse export", () => {
  it("does nothing without keys", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    expect(startTracing()).toBe(false);
    vi.unstubAllEnvs();
  });

  it("sends the agent, handoff and tool spans to Langfuse, and no customer text", async () => {
    const { port } = server.address() as AddressInfo;
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    vi.stubEnv("LANGFUSE_BASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    expect(startTracing()).toBe(true);
    expect(startTracing()).toBe(true); // safe to call twice

    configureRefunds({ store: createMemoryRefundStore() });
    let step = 0;
    const steps = [
      calls("transfer_to_refund_agent", { reason: "refund" }),
      calls("request_refund", { orderId: "1004" }),
      says("A supervisor needs to approve it. SECRET-REPLY-5521"),
    ];
    model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream(steps[step++] ?? says("")),
      }),
    });
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    await finalValue(
      (
        await askCopper({
          messages: [
            { role: "user", content: "Refund order 1004 CUSTOMER-TEXT-8842" },
          ],
          useTools: true,
          support: true,
        })
      ).progress,
    );
    await flushTraces();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), {
      timeout: 5000,
    });

    const posts = received.filter((r) => r.url.includes("/api/public/otel"));
    expect(posts.length).toBeGreaterThan(0);
    const expectedAuth = `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`;
    for (const post of posts) expect(post.auth).toBe(expectedAuth);

    // The exporter compresses what it sends.
    const wire = Buffer.concat(
      posts.map((p) => (p.encoding === "gzip" ? gunzipSync(p.body) : p.body)),
    );
    for (const text of [
      "agent:copper",
      "agent:refund",
      "handoff",
      "request_refund",
      "ask-copper-turn",
    ])
      expect(wire.includes(text), `${text} should be exported`).toBe(true);
    for (const text of [
      "CUSTOMER-TEXT-8842",
      "SECRET-REPLY-5521",
      "Copper Home",
    ])
      expect(wire.includes(text), `${text} must not be exported`).toBe(false);
  });
});
