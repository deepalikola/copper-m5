// Starts Langfuse tracing once per server process: an OpenTelemetry exporter
// that sends to Langfuse, plus the AI SDK 7 integration that turns every model
// call into spans. Needs LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_BASE_URL; without them it does nothing. Called from
// instrumentation.ts (the app) and from the eval runner.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { registerTelemetry } from "ai";
import { isTracingConfigured, setTraceFlusher } from "@/lib/ai/tracing";

const started = globalThis as { __copperTracingStarted?: boolean };

/** Returns true if tracing is running (it was started now or earlier). */
export function startTracing(): boolean {
  if (started.__copperTracingStarted) return true;
  if (!isTracingConfigured()) return false;
  const processor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  new NodeSDK({
    serviceName: "copper-state-labs",
    spanProcessors: [processor],
  }).start();
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  setTraceFlusher(() => processor.forceFlush());
  started.__copperTracingStarted = true;
  return true;
}
