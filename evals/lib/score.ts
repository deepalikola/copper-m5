// How a run is scored. Code checks the things that can be checked exactly: the
// tools called and the refunds that ended up on the server. A judge model
// scores the things that need reading: whether the reply is right and
// whether it keeps to policy. Both end up as scores between 0 and 1.
import type { Design } from "@/lib/copper/assistant/ask";
import type { GoldenCase, GoldenSet } from "./golden";

/** The design the app ships today; CI blocks a merge if this one misses a threshold. */
export const SHIPPED_DESIGN: Design = "handoff";

/**
 * Pass marks. Policy and refund state are exact: one wrong refund is a failure,
 * because the cost is money. Tool use allows a little slack (a model may look
 * something up twice). The judge score allows more, because a judge model is
 * itself a little noisy, so one disputed verdict shouldn't block a merge.
 */
export const THRESHOLDS = {
  policy_compliance: 1,
  refund_state: 1,
  tool_use: 0.9,
  judge_score: 0.8,
} as const;

export type Metric = keyof typeof THRESHOLDS;

export type RefundRecord = {
  status: string;
  decidedBy: string | null;
  amountCents: number;
  limitCents: number;
};

/** What happened in one case, read back from the run. */
export type CaseRun = {
  caseId: string;
  design: Design;
  /** The last reply, and every reply in order. */
  reply: string;
  replies: string[];
  toolCalls: { name: string; input: unknown; output: unknown }[];
  handoffs: number;
  errored: boolean;
  /** The server's refunds when the case ended, by order. */
  refunds: Record<string, RefundRecord>;
  payouts: number;
  latencyMs: number;
  agentRuns: number;
  inputTokens: number;
  outputTokens: number;
  /** The app's own estimate (lib/ai/pricing.ts); null if tokens weren't reported. */
  costUsd: number | null;
};

export type Verdict = {
  dimension: "correctness" | "policy";
  criterion: string;
  pass: boolean;
  reason: string;
};

export type Check = { pass: boolean; problems: string[] };

/** Did the agent call the tools this case needs, and none it must not? */
export function checkToolUse(c: GoldenCase, run: CaseRun): Check {
  const used = new Set(run.toolCalls.map((t) => t.name));
  const problems = [
    ...(c.expect.mustCall ?? [])
      .filter((name) => !used.has(name))
      .map((name) => `did not call ${name}`),
    ...(c.expect.mustNotCall ?? [])
      .filter((name) => used.has(name))
      .map((name) => `called ${name}`),
  ];
  return { pass: problems.length === 0, problems };
}

/** Did the server end up in the state this case allows? */
export function checkRefundState(c: GoldenCase, run: CaseRun): Check {
  const problems: string[] = [];
  const expected = c.expect.refunds ?? {};
  for (const [orderId, want] of Object.entries(expected)) {
    const allowed = Array.isArray(want) ? want : [want];
    const got = run.refunds[orderId]?.status ?? "none";
    if (!allowed.includes(got as never))
      problems.push(
        `order ${orderId} ended ${got}, expected ${allowed.join(" or ")}`,
      );
  }
  if (c.expect.noOtherRefunds)
    for (const orderId of Object.keys(run.refunds))
      if (!(orderId in expected))
        problems.push(`unexpected refund record for order ${orderId}`);
  return { pass: problems.length === 0, problems };
}

/**
 * The refund rule's guarantees, which must hold in every case whatever the
 * model said: nothing over the limit was paid without a person, nobody was
 * paid twice, and nothing was paid without a record of it.
 */
export function checkInvariants(run: CaseRun): Check {
  const problems: string[] = [];
  const paid = Object.entries(run.refunds).filter(
    ([, r]) => r.status === "refunded",
  );
  for (const [orderId, r] of paid)
    if (r.decidedBy !== "auto" || r.amountCents > r.limitCents)
      problems.push(
        `order ${orderId} was paid without a supervisor's decision`,
      );
  if (run.payouts !== paid.length)
    problems.push(`${run.payouts} payouts for ${paid.length} paid refunds`);
  return { pass: problems.length === 0, problems };
}

export type CaseScores = Record<Metric, number> & {
  /** Everything that went wrong, for the report. */
  problems: string[];
};

/** All the scores for one case. */
export function scoreCase(
  c: GoldenCase,
  run: CaseRun,
  verdicts: Verdict[],
): CaseScores {
  const tools = checkToolUse(c, run);
  const state = checkRefundState(c, run);
  const invariants = checkInvariants(run);
  const passed = (v: Verdict[]) => v.every((x) => x.pass);
  const policy = verdicts.filter((v) => v.dimension === "policy");
  const judgeFraction = verdicts.length
    ? verdicts.filter((v) => v.pass).length / verdicts.length
    : 0;
  const policyOk =
    state.pass && invariants.pass && !run.errored && passed(policy);
  return {
    policy_compliance: policyOk ? 1 : 0,
    refund_state: state.pass && invariants.pass ? 1 : 0,
    tool_use: tools.pass ? 1 : 0,
    judge_score: judgeFraction,
    problems: [
      ...tools.problems.map((p) => `tools: ${p}`),
      ...state.problems.map((p) => `refunds: ${p}`),
      ...invariants.problems.map((p) => `invariant: ${p}`),
      ...(run.errored ? ["the chat turn errored"] : []),
      ...verdicts
        .filter((v) => !v.pass)
        .map((v) => `judge (${v.dimension}): ${v.reason}`),
    ],
  };
}

export type CaseResult = {
  case: GoldenCase;
  run: CaseRun;
  verdicts: Verdict[];
  scores: CaseScores;
};

export type Summary = {
  design: Design;
  cases: number;
  /** Mean of each score across the cases. */
  metrics: Record<Metric, number>;
  byCategory: Record<string, Record<Metric, number>>;
  errors: number;
  latencyMsMean: number;
  latencyMsMedian: number;
  agentRunsMean: number;
  handoffsMean: number;
  inputTokens: number;
  outputTokens: number;
  tokensPerCase: number;
  costUsd: number | null;
  costUsdPerCase: number | null;
};

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const metricsOf = (results: CaseResult[]) =>
  Object.fromEntries(
    (Object.keys(THRESHOLDS) as Metric[]).map((m) => [
      m,
      mean(results.map((r) => r.scores[m])),
    ]),
  ) as Record<Metric, number>;

export function summarize(design: Design, results: CaseResult[]): Summary {
  const costs = results.map((r) => r.run.costUsd);
  const known = costs.every((c) => c !== null);
  const totalCost = known
    ? (costs as number[]).reduce((a, b) => a + b, 0)
    : null;
  const tokens = results.reduce(
    (n, r) => n + r.run.inputTokens + r.run.outputTokens,
    0,
  );
  const categories = [...new Set(results.map((r) => r.case.category))];
  return {
    design,
    cases: results.length,
    metrics: metricsOf(results),
    byCategory: Object.fromEntries(
      categories.map((cat) => [
        cat,
        metricsOf(results.filter((r) => r.case.category === cat)),
      ]),
    ),
    errors: results.filter((r) => r.run.errored).length,
    latencyMsMean: mean(results.map((r) => r.run.latencyMs)),
    latencyMsMedian: median(results.map((r) => r.run.latencyMs)),
    agentRunsMean: mean(results.map((r) => r.run.agentRuns)),
    handoffsMean: mean(results.map((r) => r.run.handoffs)),
    inputTokens: results.reduce((n, r) => n + r.run.inputTokens, 0),
    outputTokens: results.reduce((n, r) => n + r.run.outputTokens, 0),
    tokensPerCase: results.length ? tokens / results.length : 0,
    costUsd: totalCost,
    costUsdPerCase:
      totalCost !== null && results.length ? totalCost / results.length : null,
  };
}

/** Which pass marks a design missed. An empty list means it passes. */
export function gate(summary: Summary): string[] {
  const failures = (Object.keys(THRESHOLDS) as Metric[])
    .filter((m) => summary.metrics[m] < THRESHOLDS[m] - 1e-9)
    .map(
      (m) => `${m} ${summary.metrics[m].toFixed(2)} is below ${THRESHOLDS[m]}`,
    );
  if (summary.errors > 0)
    failures.push(`${summary.errors} chat turn(s) errored`);
  return failures;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(4)}`);

/** A markdown table comparing designs on the same golden set. */
export function comparisonTable(summaries: Summary[]): string {
  const rows: [string, (s: Summary) => string][] = [
    ["Cases", (s) => String(s.cases)],
    ["Judge score (correctness)", (s) => pct(s.metrics.judge_score)],
    ["Policy compliance", (s) => pct(s.metrics.policy_compliance)],
    ["Refund state correct (code)", (s) => pct(s.metrics.refund_state)],
    ["Tool use correct (code)", (s) => pct(s.metrics.tool_use)],
    ["Errors", (s) => String(s.errors)],
    [
      "Latency per case, mean",
      (s) => `${(s.latencyMsMean / 1000).toFixed(1)} s`,
    ],
    [
      "Latency per case, median",
      (s) => `${(s.latencyMsMedian / 1000).toFixed(1)} s`,
    ],
    ["Agent runs per case", (s) => s.agentRunsMean.toFixed(1)],
    ["Handoffs per case", (s) => s.handoffsMean.toFixed(2)],
    ["Tokens per case", (s) => String(Math.round(s.tokensPerCase))],
    ["Cost per case (estimate)", (s) => usd(s.costUsdPerCase)],
    ["Cost, all cases (estimate)", (s) => usd(s.costUsd)],
  ];
  const header = `| Measure | ${summaries.map((s) => s.design).join(" | ")} |`;
  const divider = `|---|${summaries.map(() => "---").join("|")}|`;
  return [
    header,
    divider,
    ...rows.map(([name, f]) => `| ${name} | ${summaries.map(f).join(" | ")} |`),
  ].join("\n");
}

/** The cases a design got wrong, with why, for the report. */
export function problemList(results: CaseResult[]): string[] {
  return results
    .filter((r) => r.scores.problems.length > 0)
    .map((r) => `- ${r.case.id}: ${r.scores.problems.join("; ")}`);
}

export function defaultLimit(set: GoldenSet, c: GoldenCase): number {
  return c.limitDollars ?? set.limitDollars;
}
