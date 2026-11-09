/** Topic-coverage payloads (docs/API.md §3 — `GET /projects/{id}/topics/coverage`). */
import { z } from "zod";
import { uuidSchema } from "./common.js";

export const topicCoverageSchema = z.object({
  topicId: uuidSchema,
  label: z.string(),
  /** Null until the project's own site has a completed crawl with coverage. */
  ownCoverage: z.number().int().min(0).max(100).nullable(),
  ownDepth: z.number().int().nullable(),
  /** Null until a competitor has one. */
  competitorCoverage: z.number().int().min(0).max(100).nullable(),
  /** `competitorCoverage - ownCoverage`; null when there is no competitor crawl. */
  gap: z.number().int().nullable(),
  missing: z.boolean(),
});

export type TopicCoverage = z.infer<typeof topicCoverageSchema>;

export const topicCoverageResponseSchema = z.object({
  ownCrawlId: uuidSchema.nullable(),
  competitorCrawlId: uuidSchema.nullable(),
  data: z.array(topicCoverageSchema),
});

export type TopicCoverageResponse = z.infer<typeof topicCoverageResponseSchema>;
