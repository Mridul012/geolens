/**
 * Retrievability simulation model outputs (AI-Pipeline §3.3).
 *
 * Two shapes, two different strictness policies, for a reason.
 *
 * The question set is a *contract other components consume*, so its bounds are enforced:
 * 30–50 questions, or the call is repaired and then fails. A judgment is a single verdict
 * about a single question — rejecting one because its explanation ran three characters
 * long would throw away a paid call and, at scale, push the component under its degradation
 * threshold over formatting. So the verdict is strict and the prose is truncated.
 */
import { z } from "zod";
import { buyerIntentSchema } from "./taxonomy.js";

export const buyerQuestionSchema = z.object({
  text: z.string().min(1).max(300),
  /** The taxonomy label this question came from; free text, because the model echoes it. */
  topicLabel: z.string().min(1).max(60),
  intent: buyerIntentSchema,
});

export type BuyerQuestion = z.infer<typeof buyerQuestionSchema>;

export const questionSetOutputSchema = z.object({
  questions: z.array(buyerQuestionSchema).min(30).max(50),
});

export type QuestionSetOutput = z.infer<typeof questionSetOutputSchema>;

/** Explanations longer than this are cut, never rejected. */
const MISSING_ELEMENT_MAX = 150;

export const coverageJudgmentSchema = z.object({
  answered: z.enum(["fully", "partially", "no"]),
  confidence: z.number().int().min(0).max(100),
  missingElement: z.preprocess(
    (value) =>
      typeof value === "string" && value.length > MISSING_ELEMENT_MAX
        ? value.slice(0, MISSING_ELEMENT_MAX)
        : value,
    z.string().max(MISSING_ELEMENT_MAX).nullable(),
  ),
});

export type CoverageJudgment = z.infer<typeof coverageJudgmentSchema>;
