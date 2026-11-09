/** Dashboard payload (docs/API.md §3 — the one precomputed read). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";
import { scoreSchema } from "./scores.js";
import { crawlSchema } from "./crawls.js";
import { pageSnapshotSummarySchema } from "./snapshots.js";
import { topicCoverageSchema } from "./coverage.js";

export const scoreTrendPointSchema = z.object({
  date: isoDateTime,
  composite: z.number().int().min(0).max(100),
});

export const dashboardSchema = z.object({
  /** False before the first crawl finishes — the empty state, not an error. */
  hasCompletedCrawl: z.boolean(),
  /** Null while a score is pending: fewer than half the components have a value. */
  latestScore: scoreSchema.nullable(),
  scoreTrend: z.array(scoreTrendPointSchema),
  /** The most recent crawl in any state, so the UI can show one in flight. */
  crawlStatus: crawlSchema.nullable(),
  indexedPages: z.number().int().min(0),
  recentPages: z.array(pageSnapshotSummarySchema),
  topRecommendations: z.array(z.record(z.unknown())),
  topMissingTopics: z.array(topicCoverageSchema),
  promptSummary: z
    .object({
      mentionRate: z.number().nullable(),
      citationShare: z.number().nullable(),
      lastRunAt: isoDateTime.nullable(),
    })
    .nullable(),
  comparisonSummary: z.record(z.unknown()).nullable(),
  /** When this payload was built. The dashboard is served, never computed. */
  builtAt: isoDateTime,
  projectId: uuidSchema,
});

export type Dashboard = z.infer<typeof dashboardSchema>;
