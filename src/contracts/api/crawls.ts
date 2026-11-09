/** Crawl payloads (docs/API.md §3 — Crawler group). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

export const crawlStatusSchema = z.enum([
  "QUEUED",
  "CRAWLING",
  "ANALYZING",
  "COMPLETED",
  "COMPLETED_DEGRADED",
  "FAILED",
  "CANCELED",
]);

export type CrawlStatus = z.infer<typeof crawlStatusSchema>;

export const crawlSchema = z.object({
  id: uuidSchema,
  siteId: uuidSchema,
  status: crawlStatusSchema,
  trigger: z.enum(["MANUAL", "SCHEDULED"]),
  stats: z.object({
    pagesDiscovered: z.number().int(),
    pagesCrawled: z.number().int(),
    pagesChanged: z.number().int(),
    pagesFailed: z.number().int(),
  }),
  degradation: z.record(z.unknown()).nullable(),
  errorReason: z.string().nullable(),
  scoringConfigVersion: z.string().nullable(),
  queuedAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
});

export type Crawl = z.infer<typeof crawlSchema>;
