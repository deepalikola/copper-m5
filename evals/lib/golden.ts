// The golden set: the questions Ask Copper is evaluated on, what must be true
// afterwards (checked by code), and what a judge should look for (checked by a
// model). See evals/golden-set.json.
import { readFileSync } from "node:fs";
import { z } from "zod";

export const CATEGORIES = [
  "ordinary",
  "refund",
  "approval-claim",
  "missing-info",
] as const;

const refundStatus = z.enum(["none", "pending", "refunded", "rejected"]);

const criterion = z.object({
  /** policy: must never be broken. correctness: the answer is right and helpful. */
  dimension: z.enum(["correctness", "policy"]),
  text: z.string().min(10),
});

const goldenCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(CATEGORIES),
  /** The auto-refund limit for this case; the set's default if left out. */
  limitDollars: z.number().min(0).optional(),
  /** Refunds that exist before the customer says anything. */
  setup: z
    .object({
      refunds: z.array(
        z.object({
          orderId: z.string(),
          status: z.enum(["pending", "refunded", "rejected"]),
        }),
      ),
    })
    .optional(),
  /** The customer's messages, in order. Each is answered before the next. */
  turns: z.array(z.string().min(1)).min(1),
  expect: z.object({
    mustCall: z.array(z.string()).optional(),
    mustNotCall: z.array(z.string()).optional(),
    refunds: z
      .record(z.string(), z.union([refundStatus, z.array(refundStatus).min(1)]))
      .optional(),
    noOtherRefunds: z.boolean().optional(),
  }),
  criteria: z.array(criterion).min(1),
});

const goldenSet = z.object({
  description: z.string(),
  limitDollars: z.number().min(0),
  cases: z.array(goldenCase).min(1),
});

export type GoldenCase = z.infer<typeof goldenCase>;
export type GoldenSet = z.infer<typeof goldenSet>;
export type Criterion = z.infer<typeof criterion>;

/** Reads and checks the golden set. Throws a readable error if it is malformed. */
export function loadGoldenSet(path = "evals/golden-set.json"): GoldenSet {
  const set = goldenSet.parse(JSON.parse(readFileSync(path, "utf8")));
  const ids = set.cases.map((c) => c.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length)
    throw new Error(`Golden set has repeated ids: ${repeated.join(", ")}`);
  return set;
}
