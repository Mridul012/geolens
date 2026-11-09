/**
 * Recommendation-set output (AI-Pipeline §3.6).
 *
 * The hard rule this schema exists to enforce: a recommendation whose evidence cites
 * something we cannot resolve is **dropped, not repaired**. A card that says "your pricing
 * page is thin" pointing at a snapshot that does not exist is exactly the generic AI filler
 * the PRD names as a trust risk — and once a user finds one, they stop believing the list.
 *
 * Resolution happens in the application layer, which holds the artifact; the schema's job
 * is to make the references present and well-shaped so that check is possible at all.
 */
import { z } from "zod";

const truncated = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value),
    z.string().min(1).max(max),
  );

export const recommendationEvidenceSchema = z.object({
  snapshotIds: z.array(z.string()).max(20).optional(),
  topicLabels: z.array(z.string()).max(20).optional(),
  questionIds: z.array(z.string()).max(20).optional(),
  checkKeys: z.array(z.string()).max(20).optional(),
});

export type RecommendationEvidence = z.infer<typeof recommendationEvidenceSchema>;

export const aiRecommendationSchema = z.object({
  title: truncated(80),
  body: truncated(600),
  /** Maps to a known issue type when the model recognises one; null otherwise. */
  ruleHint: z.string().max(60).nullable(),
  impact: z.number().int().min(1).max(5),
  difficulty: z.number().int().min(1).max(5),
  evidenceRefs: recommendationEvidenceSchema,
});

export type AiRecommendation = z.infer<typeof aiRecommendationSchema>;

export const recommendationSetSchema = z.object({
  recommendations: z.array(aiRecommendationSchema).min(1).max(12),
});

export type RecommendationSet = z.infer<typeof recommendationSetSchema>;
