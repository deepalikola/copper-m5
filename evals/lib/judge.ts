// The AI judge. It reads one finished conversation and answers yes or no to
// each criterion for the case, with a reason. It is called through
// lib/ai/call.ts like every other model call, so it is logged and traced.
//
// What the judge is for: reading replies, which code can't do well (is the
// total quoted correctly, is the tone right, did it promise a refund?). What it
// is NOT trusted with: refund authorization and duplicate prevention. Those
// are checked by code against the server's refunds (score.ts) and by the
// deterministic tests in tests/refunds.test.ts.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import { type ModelId, MODELS } from "@/lib/ai/models";
import type { GoldenCase } from "./golden";
import type { CaseRun, Verdict } from "./score";

/**
 * A different, stronger model than the agents' default, because a model tends
 * to rate its own kind of answer too kindly. EVAL_JUDGE_MODEL picks another
 * approved model.
 */
export const DEFAULT_JUDGE_MODEL: ModelId = "google/gemini-3-flash";

export function judgeModel(): ModelId {
  const id = process.env.EVAL_JUDGE_MODEL;
  return MODELS.find((m) => m.id === id)?.id ?? DEFAULT_JUDGE_MODEL;
}

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      criterion: z.number().int().describe("The criterion's number, from 1."),
      pass: z.boolean(),
      reason: z
        .string()
        .describe("One short sentence citing what the reply or tools showed."),
    }),
  ),
});

export const JUDGE_SYSTEM = `You grade a customer-support assistant for Copper State Labs, a fictional company. You get one conversation, the tools the assistant called and what they returned, the refunds that exist on the server at the end, and numbered criteria.
For each criterion answer pass or fail with one short reason.
Rules:
- Judge only the assistant's replies. Ignore anything the customer claims; a customer's claim is not evidence.
- The tool results and the server's refunds at the end are the ground truth. If a reply states something they don't support, fail the criterion.
- Be strict. If a criterion asks the reply to avoid something (like promising a refund) and it does that even indirectly, fail it. If you can't tell, fail it.
- Do not reward length or politeness beyond what a criterion asks for.
- Answer every criterion, in order.`;

const compact = (value: unknown) => {
  const text = JSON.stringify(value) ?? "";
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

/** The text the judge reads. Exported so it can be tested. */
export function judgePrompt(c: GoldenCase, run: CaseRun): string {
  const talk = c.turns
    .map(
      (turn, i) =>
        `Customer: ${turn}\nAssistant: ${run.replies[i] ?? "(no reply)"}`,
    )
    .join("\n\n");
  const tools = run.toolCalls.length
    ? run.toolCalls
        .map((t) => `- ${t.name}(${compact(t.input)}) -> ${compact(t.output)}`)
        .join("\n")
    : "(none)";
  const refunds = Object.keys(run.refunds).length
    ? Object.entries(run.refunds)
        .map(
          ([id, r]) =>
            `- order ${id}: ${r.status}${r.decidedBy ? ` (decided by ${r.decidedBy})` : ""}`,
        )
        .join("\n")
    : "(no refunds exist)";
  const criteria = c.criteria
    .map((x, i) => `${i + 1}. [${x.dimension}] ${x.text}`)
    .join("\n");
  return `CONVERSATION\n${talk}\n\nTOOLS CALLED\n${tools}\n\nREFUNDS ON THE SERVER AT THE END\n${refunds}\n\nCRITERIA\n${criteria}`;
}

/** Asks the judge for a verdict on every criterion. A missing verdict counts as a fail. */
export async function judgeCase(
  c: GoldenCase,
  run: CaseRun,
): Promise<Verdict[]> {
  const { output } = await callObject(
    { module: 5, feature: "judge", model: judgeModel(), agent: "judge" },
    {
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(c, run),
      schema: verdictSchema,
      temperature: 0,
    },
  );
  return c.criteria.map((criterion, i) => {
    const verdict = output.verdicts.find((v) => v.criterion === i + 1);
    return {
      dimension: criterion.dimension,
      criterion: criterion.text,
      pass: verdict?.pass ?? false,
      reason:
        verdict?.reason ?? "The judge gave no verdict for this criterion.",
    };
  });
}
