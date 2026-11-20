// Next.js runs register() once when the server starts. Tracing is started only
// on the Node.js runtime, and only when the Langfuse keys are set.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTracing } = await import("@/lib/ai/tracing-setup");
  startTracing();
}
