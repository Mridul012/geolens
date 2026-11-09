/** Recommendation payloads (docs/API.md §3 — Recommendations group). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

export const recStatusSchema = z.enum(["OPEN", "DONE", "DISMISSED", "VALIDATED", "REGRESSED"]);
export const recPrioritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export const recommendationSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  source: z.enum(["RULE", "AI"]),
  priority: recPrioritySchema,
  impact: z.number().int().min(1).max(5),
  difficulty: z.number().int().min(1).max(5),
  status: recStatusSchema,
  firstSeenAt: isoDateTime,
  updatedAt: isoDateTime,
});

export type Recommendation = z.infer<typeof recommendationSchema>;

export const recommendationDetailSchema = recommendationSchema.extend({
  body: z.string(),
  /** Null for a model's suggestion; the rule's key for a deterministic finding. */
  ruleKey: z.string().nullable(),
  /** Ids the client resolves through the snapshot and analysis endpoints. */
  evidence: z.record(z.unknown()),
  firstSeenCrawlId: uuidSchema.nullable(),
  lastSeenCrawlId: uuidSchema.nullable(),
  resolvedAt: isoDateTime.nullable(),
});

export type RecommendationDetail = z.infer<typeof recommendationDetailSchema>;

export const recommendationListQuerySchema = z.object({
  status: recStatusSchema.optional(),
  priority: recPrioritySchema.optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const recommendationListSchema = z.object({
  data: z.array(recommendationSchema),
  nextCursor: z.string().nullable(),
});

/** Only the three statuses a client owns; the other two are pipeline-set. */
export const updateRecommendationBodySchema = z.object({
  status: z.enum(["OPEN", "DONE", "DISMISSED"]),
});
