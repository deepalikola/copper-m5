// @vitest-environment node
// The golden-set evaluation (Module 5): `npm run eval`.
//
// It plays every golden case through the real app code with a real model, once
// for each design (the two-agent handoff and the single agent), on the same
// questions, data, model and judging criteria. Code checks refund state and
// tool use; an AI judge reads the replies. Scores go to Langfuse (one run per
// design, grouped in one experiment so the runs can be compared there) and to
// eval-results/. The test fails if the shipped design misses a pass mark.
//
// Environment:
//   GOOGLE_GENERATIVE_AI_API_KEY   needed: the agents and the judge use Gemini
//   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL   scores and traces
//   EVAL_REQUIRE_LANGFUSE=1        fail if Langfuse isn't set up (CI sets this)
//   EVAL_DESIGNS=handoff,single    which designs to run (default both)
//   EVAL_CASES=id,id               only these cases (a quick check; skips the gate)
//   AI_MODEL, EVAL_JUDGE_MODEL     approved model ids for the agents and the judge
import { mkdirSync, writeFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { createTraceId } from "@langfuse/tracing";
import { describe, expect, it } from "vitest";
import { isAiConfigured } from "@/lib/ai/call";
import { defaultModel } from "@/lib/ai/models";
import { flushTraces, isTracingConfigured } from "@/lib/ai/tracing";
import { startTracing } from "@/lib/ai/tracing-setup";
import type { Design } from "@/lib/copper/assistant/ask";
import { runCase } from "./lib/conversation";
import { loadGoldenSet } from "./lib/golden";
import { judgeCase, judgeModel } from "./lib/judge";
import { retryPatiently } from "./lib/retry";
import {
  type CaseResult,
  type CaseRun,
  comparisonTable,
  gate,
  problemList,
  scoreCase,
  SHIPPED_DESIGN,
  summarize,
  THRESHOLDS,
  type Verdict,
} from "./lib/score";

// The golden questions are made up, so it is fine to keep their text in
// traces; real customer chats never set this (see lib/ai/tracing.ts).
process.env.AI_TRACE_CONTENT = "1";

const ALL: Design[] = ["handoff", "single"];

function requestedDesigns(): Design[] {
  const asked = (process.env.EVAL_DESIGNS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const bad = asked.filter((d) => !ALL.includes(d as Design));
  if (bad.length) throw new Error(`Unknown EVAL_DESIGNS: ${bad.join(", ")}`);
  return asked.length ? (asked as Design[]) : ALL;
}

describe("golden set", () => {
  it("meets the pass marks for the shipped design", async () => {
    if (!isAiConfigured())
      throw new Error(
        "Set GOOGLE_GENERATIVE_AI_API_KEY to run the evaluation (it calls Gemini for the agents and the judge).",
      );
    if (process.env.EVAL_REQUIRE_LANGFUSE === "1" && !isTracingConfigured())
      throw new Error(
        "Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL: this run must record its scores in Langfuse.",
      );

    const set = loadGoldenSet();
    const only = (process.env.EVAL_CASES ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const cases = only.length
      ? set.cases.filter((c) => only.includes(c.id))
      : set.cases;
    if (only.length && cases.length !== only.length)
      throw new Error("EVAL_CASES names a case that isn't in the golden set.");

    const designs = requestedDesigns();
    const stamp = process.env.GITHUB_RUN_ID ?? new Date().toISOString();
    const langfuse = startTracing() ? new LangfuseClient() : null;
    const experimentId = await createTraceId(`copper-golden-${stamp}`);

    async function evaluate(design: Design): Promise<CaseResult[]> {
      const results = new Map<string, CaseResult>();
      // Each item carries its case's id in `metadata`, set below.
      const caseOf = (item: { metadata?: unknown }) => {
        const id = (item.metadata as { id?: string } | undefined)?.id;
        const found = cases.find((c) => c.id === id);
        if (!found) throw new Error(`No golden case for item ${String(id)}`);
        return found;
      };

      // A rate-limited turn errors; run the whole case again from a fresh
      // store after a wait, so the result reflects the agent, not the quota.
      const task = async (item: { metadata?: unknown }) => {
        const c = caseOf(item);
        return retryPatiently(() => runCase(set, c, design), {
          failed: (run) => run.errored,
          onRetry: (attempt, ms) =>
            console.warn(
              `[eval] ${design}/${c.id}: a chat turn errored, retry ${attempt} in ${ms / 1000} s`,
            ),
        });
      };

      const evaluator = async (item: {
        output: CaseRun;
        metadata?: unknown;
      }) => {
        const c = caseOf(item);
        // If the judge can't be reached the criteria fail, so the gate fails
        // closed instead of passing on missing evidence.
        const verdicts: Verdict[] = await retryPatiently(
          () => judgeCase(c, item.output),
          {
            onRetry: (attempt, ms) =>
              console.warn(
                `[eval] ${design}/${c.id}: the judge failed, retry ${attempt} in ${ms / 1000} s`,
              ),
          },
        ).catch((error: unknown) =>
          c.criteria.map((x) => ({
            dimension: x.dimension,
            criterion: x.text,
            pass: false,
            reason: `The judge failed: ${String(error).slice(0, 120)}`,
          })),
        );
        const scores = scoreCase(c, item.output, verdicts);
        results.set(c.id, { case: c, run: item.output, verdicts, scores });
        const comment = scores.problems.join("; ") || undefined;
        return [
          { name: "judge_score", value: scores.judge_score },
          {
            name: "policy_compliance",
            value: scores.policy_compliance,
            comment,
          },
          { name: "refund_state", value: scores.refund_state },
          { name: "tool_use", value: scores.tool_use },
          { name: "latency_ms", value: item.output.latencyMs },
          {
            name: "total_tokens",
            value: item.output.inputTokens + item.output.outputTokens,
          },
          ...(item.output.costUsd === null
            ? []
            : [{ name: "cost_usd", value: item.output.costUsd }]),
        ];
      };

      const data = cases.map((c) => ({
        input: { turns: c.turns, category: c.category },
        expectedOutput: c.expect,
        metadata: { id: c.id, category: c.category, design },
      }));

      if (langfuse) {
        await langfuse.experiment.run({
          name: "copper-support-golden-set",
          runName: `${design}-${stamp}`,
          experimentId,
          description: `Golden set, ${design} design`,
          metadata: {
            design,
            model: defaultModel(),
            judge: judgeModel(),
          },
          data,
          task,
          evaluators: [evaluator],
          // One case at a time: each case swaps the refund store and counts
          // its own tokens, so they can't overlap.
          maxConcurrency: 1,
        });
      } else {
        for (const item of data) {
          const output = await task(item);
          await evaluator({ output, metadata: item.metadata });
        }
      }
      return cases.map((c) => results.get(c.id)).filter((r) => !!r);
    }

    const byDesign = new Map<Design, CaseResult[]>();
    for (const design of designs) byDesign.set(design, await evaluate(design));
    const summaries = designs.map((d) => summarize(d, byDesign.get(d)!));

    const lines = [
      "# Ask Copper golden-set evaluation",
      "",
      `- Run: ${stamp}`,
      `- Agent model: ${defaultModel()}. Judge model: ${judgeModel()}.`,
      `- Cases: ${cases.length}${only.length ? " (a subset)" : ""}. Designs: ${designs.join(", ")}.`,
      `- Langfuse: ${langfuse ? "scores and traces recorded (experiment copper-support-golden-set)" : "not set up, so nothing was recorded there"}.`,
      "",
      comparisonTable(summaries),
      "",
      `Pass marks: ${Object.entries(THRESHOLDS)
        .map(([m, t]) => `${m} >= ${t}`)
        .join(", ")}, no errors. Gate: the ${SHIPPED_DESIGN} design.`,
      "",
      "A judge model is itself imperfect: treat judge_score as a signal, and the code-checked refund_state, tool_use and policy_compliance as the hard checks. With this few cases, one case is worth several points, so small gaps between designs are not evidence.",
    ];
    for (const design of designs) {
      const problems = problemList(byDesign.get(design)!);
      lines.push(
        "",
        `## ${design}: ${problems.length ? "cases to look at" : "no problems found"}`,
      );
      lines.push(...problems);
    }
    const report = lines.join("\n");
    mkdirSync("eval-results", { recursive: true });
    writeFileSync("eval-results/summary.md", `${report}\n`);
    writeFileSync(
      "eval-results/results.json",
      JSON.stringify(
        {
          stamp,
          agentModel: defaultModel(),
          judgeModel: judgeModel(),
          summaries,
          cases: Object.fromEntries(
            designs.map((d) => [
              d,
              byDesign.get(d)!.map((r) => ({
                id: r.case.id,
                category: r.case.category,
                scores: r.scores,
                verdicts: r.verdicts,
                run: r.run,
              })),
            ]),
          ),
        },
        null,
        2,
      ),
    );
    process.stdout.write(`\n${report}\n`);

    await flushTraces();
    await langfuse?.flush();

    // A subset is a quick look, not a gate.
    if (only.length) return;
    const gated = designs.includes(SHIPPED_DESIGN) ? [SHIPPED_DESIGN] : designs;
    for (const design of gated)
      expect(
        gate(summaries.find((s) => s.design === design)!),
        `${design} design pass marks`,
      ).toEqual([]);
  });
});
