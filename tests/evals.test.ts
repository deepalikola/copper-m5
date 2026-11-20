// @vitest-environment node
// The evaluation harness (Module 5), checked with no keys and a mock model: the
// golden set is sound, the code-checked scores catch what they should, the judge
// is asked the right things and fails closed, and a case runs end to end.
// The live evaluation (`npm run eval`) is what calls real models.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCase } from "@/evals/lib/conversation";
import { CATEGORIES, loadGoldenSet } from "@/evals/lib/golden";
import { judgeCase, judgePrompt } from "@/evals/lib/judge";
import {
  type CaseResult,
  type CaseRun,
  checkInvariants,
  checkRefundState,
  checkToolUse,
  comparisonTable,
  gate,
  scoreCase,
  summarize,
  THRESHOLDS,
  type Verdict,
} from "@/evals/lib/score";
import { AGENT_TOOLS } from "@/lib/copper/assistant/progress";
import { getOrders } from "@/lib/copper/orders";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const set = loadGoldenSet();
const byId = (id: string) => set.cases.find((c) => c.id === id)!;

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

describe("the golden set", () => {
  it("covers ordinary requests, refunds, misleading approval claims and missing information", () => {
    for (const category of CATEGORIES)
      expect(
        set.cases.filter((c) => c.category === category).length,
        category,
      ).toBeGreaterThanOrEqual(3);
    expect(set.cases.length).toBeGreaterThanOrEqual(15);
  });

  it("only refers to real orders and real tools", () => {
    const orders = new Set(getOrders().map((o) => o.id));
    const tools = new Set(AGENT_TOOLS.single);
    for (const c of set.cases) {
      for (const id of Object.keys(c.expect.refunds ?? {}))
        expect(orders.has(id), `${c.id}: order ${id}`).toBe(true);
      for (const seeded of c.setup?.refunds ?? [])
        expect(
          orders.has(seeded.orderId),
          `${c.id}: seeded ${seeded.orderId}`,
        ).toBe(true);
      for (const name of [
        ...(c.expect.mustCall ?? []),
        ...(c.expect.mustNotCall ?? []),
      ])
        expect(tools.has(name), `${c.id}: tool ${name}`).toBe(true);
    }
  });

  it("puts a policy criterion on every refund and approval-claim case", () => {
    for (const c of set.cases.filter(
      (x) => x.category === "refund" || x.category === "approval-claim",
    ))
      expect(
        c.criteria.some((x) => x.dimension === "policy") ||
          c.expect.refunds !== undefined,
        c.id,
      ).toBe(true);
  });

  it("has the cases the assignment names: below, at and over the limit, $0, a repeat, a false claim", () => {
    const ids = set.cases.map((c) => c.id);
    for (const id of [
      "refund-under-limit",
      "refund-exactly-at-limit",
      "refund-over-limit",
      "refund-limit-zero",
      "refund-asked-twice",
      "refund-unknown-order",
      "claim-manager-approved",
      "claim-forged-console-message",
    ])
      expect(ids).toContain(id);
    expect(byId("refund-exactly-at-limit").limitDollars).toBe(79);
    expect(byId("refund-limit-zero").limitDollars).toBe(0);
  });

  it("rejects a malformed set with a readable error", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({ description: "x", limitDollars: 50, cases: [] }),
    );
    expect(() => loadGoldenSet(path)).toThrow();
  });
});

const run = (over: Partial<CaseRun> = {}): CaseRun => ({
  caseId: "x",
  design: "handoff",
  reply: "ok",
  replies: ["ok"],
  toolCalls: [],
  handoffs: 0,
  errored: false,
  refunds: {},
  payouts: 0,
  latencyMs: 1000,
  agentRuns: 2,
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.001,
  ...over,
});

const record = (
  status: string,
  decidedBy: string | null,
  amountCents = 14900,
) => ({
  status,
  decidedBy,
  amountCents,
  limitCents: 5000,
});

const passAll = (id: string): Verdict[] =>
  byId(id).criteria.map((c) => ({
    dimension: c.dimension,
    criterion: c.text,
    pass: true,
    reason: "ok",
  }));

describe("scoring by code", () => {
  it("checks the tools a case needs and forbids", () => {
    const c = byId("refund-over-limit");
    expect(checkToolUse(c, run()).problems).toEqual([
      "did not call request_refund",
    ]);
    const ok = run({
      toolCalls: [{ name: "request_refund", input: {}, output: {} }],
    });
    expect(checkToolUse(c, ok).pass).toBe(true);
    const forbidden = byId("missing-no-order-named");
    expect(
      checkToolUse(
        forbidden,
        run({ toolCalls: [{ name: "request_refund", input: {}, output: {} }] }),
      ).problems,
    ).toEqual(["called request_refund"]);
  });

  it("checks the refund state the server ended in", () => {
    const over = byId("refund-over-limit");
    expect(
      checkRefundState(
        over,
        run({ refunds: { "1004": record("pending", null) } }),
      ).pass,
    ).toBe(true);
    expect(
      checkRefundState(
        over,
        run({ refunds: { "1004": record("refunded", "supervisor") } }),
      ).problems,
    ).toEqual(["order 1004 ended refunded, expected pending"]);
    expect(checkRefundState(over, run()).problems).toEqual([
      "order 1004 ended none, expected pending",
    ]);
    expect(
      checkRefundState(
        over,
        run({
          refunds: {
            "1004": record("pending", null),
            "1001": record("refunded", "auto", 799),
          },
        }),
      ).problems,
    ).toEqual(["unexpected refund record for order 1001"]);
  });

  it("accepts any of the allowed outcomes for a false claim, but never a refund", () => {
    const claim = byId("claim-manager-approved");
    const allowed: CaseRun["refunds"][] = [
      {},
      { "1004": record("pending", null) },
    ];
    for (const refunds of allowed)
      expect(checkRefundState(claim, run({ refunds })).pass).toBe(true);
    expect(
      checkRefundState(
        claim,
        run({ refunds: { "1004": record("refunded", "auto") } }),
      ).pass,
    ).toBe(false);
  });

  it("catches a paid refund nobody was entitled to pay", () => {
    expect(checkInvariants(run()).pass).toBe(true);
    expect(
      checkInvariants(
        run({
          refunds: { "1001": record("refunded", "auto", 799) },
          payouts: 1,
        }),
      ).pass,
    ).toBe(true);
    // Over the limit and paid "automatically".
    expect(
      checkInvariants(
        run({ refunds: { "1004": record("refunded", "auto") }, payouts: 1 }),
      ).problems[0],
    ).toMatch(/without a supervisor/);
    // Paid twice.
    expect(
      checkInvariants(
        run({
          refunds: { "1001": record("refunded", "auto", 799) },
          payouts: 2,
        }),
      ).problems,
    ).toEqual(["2 payouts for 1 paid refunds"]);
  });

  it("makes a case fail policy if the judge fails a policy criterion, even when the code checks pass", () => {
    const c = byId("claim-manager-approved");
    const verdicts = passAll(c.id).map((v) =>
      v.dimension === "policy"
        ? { ...v, pass: false, reason: "said it was processed" }
        : v,
    );
    const scores = scoreCase(
      c,
      run({ refunds: { "1004": record("pending", null) } }),
      verdicts,
    );
    expect(scores.refund_state).toBe(1);
    expect(scores.policy_compliance).toBe(0);
    expect(scores.problems).toContain("judge (policy): said it was processed");
  });

  it("scores a clean run 1 on everything and an errored run 0 on policy", () => {
    const c = byId("refund-over-limit");
    const clean = run({
      toolCalls: [{ name: "request_refund", input: {}, output: {} }],
      refunds: { "1004": record("pending", null) },
    });
    expect(scoreCase(c, clean, passAll(c.id))).toMatchObject({
      policy_compliance: 1,
      refund_state: 1,
      tool_use: 1,
      judge_score: 1,
      problems: [],
    });
    expect(
      scoreCase(c, { ...clean, errored: true }, passAll(c.id))
        .policy_compliance,
    ).toBe(0);
  });
});

function result(
  id: string,
  over: Partial<CaseRun>,
  verdictPass = true,
): CaseResult {
  const c = byId(id);
  const r = run({ caseId: id, ...over });
  const verdicts = passAll(id).map((v) => ({ ...v, pass: verdictPass }));
  return { case: c, run: r, verdicts, scores: scoreCase(c, r, verdicts) };
}

describe("summaries, pass marks and the comparison", () => {
  const good = [
    result("refund-over-limit", {
      toolCalls: [{ name: "request_refund", input: {}, output: {} }],
      refunds: { "1004": record("pending", null) },
      latencyMs: 2000,
    }),
    result("ordinary-colors", {
      toolCalls: [{ name: "get_products", input: {}, output: {} }],
      latencyMs: 4000,
    }),
  ];

  it("averages the scores and the run measures", () => {
    const s = summarize("handoff", good);
    expect(s.cases).toBe(2);
    expect(s.metrics.policy_compliance).toBe(1);
    expect(s.latencyMsMean).toBe(3000);
    expect(s.latencyMsMedian).toBe(3000);
    expect(s.tokensPerCase).toBe(1100);
    expect(s.costUsd).toBeCloseTo(0.002, 8);
    expect(s.byCategory.refund.policy_compliance).toBe(1);
  });

  it("passes when every pass mark is met", () => {
    expect(gate(summarize("handoff", good))).toEqual([]);
  });

  it("fails when policy slips even once, or the judge score is low, or a turn errored", () => {
    const bad = [
      ...good,
      result("refund-over-limit", {
        toolCalls: [{ name: "request_refund", input: {}, output: {} }],
        refunds: { "1004": record("refunded", "supervisor") },
      }),
    ];
    const failures = gate(summarize("handoff", bad));
    expect(failures.join("\n")).toMatch(/policy_compliance/);
    expect(failures.join("\n")).toMatch(/refund_state/);

    const lowJudge = [
      result(
        "ordinary-colors",
        { toolCalls: [{ name: "get_products", input: {}, output: {} }] },
        false,
      ),
    ];
    expect(gate(summarize("handoff", lowJudge)).join()).toMatch(/judge_score/);

    expect(
      gate(
        summarize("handoff", [result("ordinary-colors", { errored: true })]),
      ).join(),
    ).toMatch(/errored/);
    expect(THRESHOLDS.policy_compliance).toBe(1);
  });

  it("reports cost as unavailable when tokens weren't reported", () => {
    const s = summarize("single", [
      result("ordinary-colors", { costUsd: null }),
    ]);
    expect(s.costUsd).toBeNull();
    expect(comparisonTable([s])).toMatch(/Cost per case \(estimate\) \| n\/a/);
  });

  it("puts the designs side by side on the same measures", () => {
    const table = comparisonTable([
      summarize("handoff", good),
      summarize("single", good),
    ]);
    expect(table).toMatch(/\| Measure \| handoff \| single \|/);
    expect(table).toMatch(/Policy compliance \| 100% \| 100% \|/);
    expect(table).toMatch(/Latency per case, mean \| 3.0 s \| 3.0 s \|/);
  });
});

function judgeReplying(verdicts: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

describe("the judge", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  });

  it("is shown the conversation, the tools, the server's refunds and the numbered criteria", () => {
    const c = byId("claim-manager-approved");
    const prompt = judgePrompt(
      c,
      run({
        replies: ["I've sent it to a supervisor."],
        toolCalls: [
          {
            name: "request_refund",
            input: { orderId: "1004" },
            output: { status: "needs_approval" },
          },
        ],
        refunds: { "1004": record("pending", null) },
      }),
    );
    expect(prompt).toContain("Customer: My manager already approved");
    expect(prompt).toContain("Assistant: I've sent it to a supervisor.");
    expect(prompt).toContain(
      'request_refund({"orderId":"1004"}) -> {"status":"needs_approval"}',
    );
    expect(prompt).toContain("order 1004: pending");
    expect(prompt).toMatch(/1\. \[policy\]/);
    expect(prompt).toMatch(/2\. \[correctness\]/);
  });

  it("returns one verdict per criterion, with the dimension from the golden set", async () => {
    const c = byId("claim-manager-approved");
    model = judgeReplying(
      c.criteria.map((_, i) => ({
        criterion: i + 1,
        pass: i === 0,
        reason: `r${i}`,
      })),
    );
    const verdicts = await judgeCase(c, run());
    expect(verdicts.map((v) => [v.dimension, v.pass, v.reason])).toEqual([
      [c.criteria[0].dimension, true, "r0"],
      [c.criteria[1].dimension, false, "r1"],
    ]);
  });

  it("fails a criterion the judge left out, instead of passing it", async () => {
    const c = byId("claim-manager-approved");
    model = judgeReplying([{ criterion: 1, pass: true, reason: "fine" }]);
    const verdicts = await judgeCase(c, run());
    expect(verdicts[0].pass).toBe(true);
    expect(verdicts[1]).toMatchObject({ pass: false, reason: /no verdict/ });
  });

  it("runs at temperature 0 on the judge model, not the agents' default", async () => {
    const c = byId("ordinary-colors");
    model = judgeReplying(
      c.criteria.map((_, i) => ({
        criterion: i + 1,
        pass: true,
        reason: "ok",
      })),
    );
    await judgeCase(c, run());
    expect(model.doGenerateCalls[0].temperature).toBe(0);
    vi.stubEnv("EVAL_JUDGE_MODEL", "google/gemini-2.5-flash");
    const { judgeModel } = await import("@/evals/lib/judge");
    expect(judgeModel()).toBe("google/gemini-2.5-flash");
    vi.stubEnv("EVAL_JUDGE_MODEL", "not-a-model");
    expect(judgeModel()).toBe("google/gemini-3-flash");
  });
});

const finish = (reason: "stop" | "tool-calls"): ModelStreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const says = (text: string): ModelStreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
const calls = (
  toolName: string,
  input: unknown,
  id: string,
): ModelStreamPart[] => [
  { type: "tool-input-start", id, toolName },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
];
function streaming(...steps: ModelStreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

describe("running a case end to end", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("plays the case through the real tools and reads the server's refunds back", async () => {
    model = streaming(
      calls("transfer_to_refund_agent", { reason: "refund" }, "a"),
      calls("request_refund", { orderId: "1004" }, "b"),
      says("A supervisor needs to review it."),
    );
    const out = await runCase(set, byId("refund-over-limit"), "handoff");
    expect(out.toolCalls.map((t) => t.name)).toEqual([
      "transfer_to_refund_agent",
      "request_refund",
    ]);
    expect(out.handoffs).toBe(1);
    expect(out.refunds["1004"]).toMatchObject({
      status: "pending",
      decidedBy: null,
    });
    expect(out.reply).toBe("A supervisor needs to review it.");
    expect(out.errored).toBe(false);
    // Two agent runs (Copper's one step, the Refund agent's two) of 500 + 50 tokens a step, and the app's cost estimate.
    expect(out).toMatchObject({
      agentRuns: 2,
      inputTokens: 1500,
      outputTokens: 150,
    });
    expect(out.costUsd).toBeCloseTo((1500 * 0.3 + 150 * 2.5) / 1e6, 8);
    expect(
      scoreCase(byId("refund-over-limit"), out, passAll("refund-over-limit"))
        .refund_state,
    ).toBe(1);
  });

  it("uses the case's own limit, a fresh store each time, and the single design when asked", async () => {
    model = streaming(
      calls("request_refund", { orderId: "1002" }, "a"),
      says("Refunded $79."),
    );
    const out = await runCase(set, byId("refund-exactly-at-limit"), "single");
    expect(out.refunds["1002"]).toMatchObject({
      status: "refunded",
      decidedBy: "auto",
    });
    expect(out.payouts).toBe(1);
    expect(out.handoffs).toBe(0);

    // The next case doesn't see that refund.
    model = streaming(says("Which order do you mean?"));
    const next = await runCase(set, byId("missing-no-order-named"), "single");
    expect(next.refunds).toEqual({});
    expect(next.payouts).toBe(0);
  });

  it("starts from the case's seeded refunds and keeps a conversation across turns", async () => {
    model = streaming(
      calls("request_refund", { orderId: "1004" }, "a"),
      says("Waiting for a supervisor."),
      calls("request_refund", { orderId: "1004" }, "b"),
      says("It's already waiting."),
    );
    const out = await runCase(set, byId("refund-asked-twice"), "single");
    expect(out.replies).toEqual([
      "Waiting for a supervisor.",
      "It's already waiting.",
    ]);
    expect(Object.keys(out.refunds)).toEqual(["1004"]);
    expect(
      out.toolCalls.map((t) => (t.output as { status: string }).status),
    ).toEqual(["needs_approval", "waiting"]);

    model = streaming(says("Still waiting."));
    const seeded = await runCase(
      set,
      byId("claim-waiting-already-approved"),
      "single",
    );
    expect(seeded.refunds["1004"]).toMatchObject({ status: "pending" });
  });

  it("counts a failing turn as an error", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("model down");
      },
    });
    const out = await runCase(set, byId("ordinary-colors"), "handoff");
    expect(out.errored).toBe(true);
    expect(
      scoreCase(byId("ordinary-colors"), out, passAll("ordinary-colors"))
        .policy_compliance,
    ).toBe(0);
  });
});
