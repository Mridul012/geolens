/** Page snapshot payloads (docs/API.md §3 — Crawler group, evidence views). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

export const pageSnapshotSummarySchema = z.object({
  id: uuidSchema,
  pageId: uuidSchema,
  url: z.string(),
  title: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  changed: z.boolean(),
  wordCount: z.number().int().nullable(),
  /** null means the page was not in the sampled set, not that it scored zero. */
  qualityScore: z.number().int().nullable(),
  fetchedAt: isoDateTime,
});

export type PageSnapshotSummary = z.infer<typeof pageSnapshotSummarySchema>;

export const pageSnapshotDetailSchema = pageSnapshotSummarySchema.extend({
  hasStructuredData: z.boolean(),
  internalLinkCount: z.number().int().nullable(),
  externalLinkCount: z.number().int().nullable(),
  extracted: z.record(z.unknown()),
  quality: z.record(z.unknown()).nullable(),
  carriedForwardFromId: uuidSchema.nullable(),
});

export type PageSnapshotDetail = z.infer<typeof pageSnapshotDetailSchema>;

export const eventSchema = z.object({
  /** bigint, string-encoded (Engineering-Rules §3). */
  id: z.string(),
  kind: z.string(),
  payload: z.record(z.unknown()),
  crawlId: uuidSchema.nullable(),
  promptRunId: uuidSchema.nullable(),
  createdAt: isoDateTime,
});

export type EventPayload = z.infer<typeof eventSchema>;
