/**
 * The ambiguity judge's verdict (AI-Pipeline §4.2).
 *
 * Called only when the deterministic parser cannot decide. The reasoning is stored with
 * the cell, so a customer disputing a mention can see exactly why it was counted.
 */
import { z } from "zod";

const REASONING_MAX = 200;

export const mentionJudgmentSchema = z.object({
  refersToBrand: z.boolean(),
  reasoning: z.preprocess(
    (value) =>
      typeof value === "string" && value.length > REASONING_MAX
        ? value.slice(0, REASONING_MAX)
        : value,
    z.string().max(REASONING_MAX),
  ),
});

export type MentionJudgment = z.infer<typeof mentionJudgmentSchema>;
