/** Score payloads (docs/API.md §3 — Analysis group). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

const componentScore = z.number().int().min(0).max(100).nullable();

export const scoreSchema = z.object({
  id: uuidSchema,
  composite: z.number().int().min(0).max(100),
  scoreCitation: componentScore,
  scoreRetrievability: componentScore,
  scoreContentQuality: componentScore,
  scoreTopicCoverage: componentScore,
  scoreTechnical: componentScore,
  scoreTrust: componentScore,
  crawlId: uuidSchema.nullable(),
  promptRunId: uuidSchema.nullable(),
  scoringConfigVersion: z.string(),
  createdAt: isoDateTime,
});

export type Score = z.infer<typeof scoreSchema>;
