/** Comparison payload (docs/API.md §3 — Competitors). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";
import { topicCoverageSchema } from "./coverage.js";

const metric = z.number().int().nullable();

export const comparisonMetricsSchema = z.object({
  aiVisibility: metric,
  topicCoverage: metric,
  authority: metric,
  contentFreshness: metric,
  pageCount: metric,
  blogCoverage: metric,
  trustSignals: metric,
});

export const comparisonSideSchema = z.object({
  siteId: uuidSchema,
  domain: z.string(),
  name: z.string().nullable(),
  /** Null until the site's first crawl completes. */
  crawlId: uuidSchema.nullable(),
  metrics: comparisonMetricsSchema,
});

export const shareOfVoiceSchema = z.object({
  overall: z.number().nullable(),
  perEngine: z.array(
    z.object({
      engine: z.string(),
      ownCitations: z.number().int(),
      competitorCitations: z.number().int(),
      shareOfVoice: z.number().nullable(),
    }),
  ),
  competitorCitations: z.record(z.number()),
  runId: uuidSchema,
  measuredAt: isoDateTime.nullable(),
});

export const comparisonSchema = z.object({
  own: comparisonSideSchema,
  /** Null when the project tracks no competitor at all. */
  competitor: comparisonSideSchema.nullable(),
  /** Null until a prompt run has completed — never zeroes. */
  shareOfVoice: shareOfVoiceSchema.nullable(),
  missingTopics: z.array(topicCoverageSchema),
});

export type Comparison = z.infer<typeof comparisonSchema>;
