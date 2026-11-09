/** Prompt-run payloads (docs/API.md §3 — Prompt Tracking). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

export const promptRunStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "COMPLETED_DEGRADED",
  "FAILED",
]);

export const promptRunSchema = z.object({
  id: uuidSchema,
  status: promptRunStatusSchema,
  trigger: z.enum(["MANUAL", "SCHEDULED"]),
  engines: z.array(z.string()),
  /** 0–100, or null while the run has produced no evaluable cell. */
  mentionRate: z.number().nullable(),
  citationShare: z.number().nullable(),
  /** Per-engine breakdown and share of voice. */
  metrics: z.record(z.unknown()).nullable(),
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});

export type PromptRun = z.infer<typeof promptRunSchema>;

export const promptResultSchema = z.object({
  /** bigint, string-encoded: JSON cannot carry it otherwise. */
  id: z.string(),
  promptTemplateId: uuidSchema,
  engine: z.string(),
  sampleIndex: z.number().int(),
  brandMentioned: z.boolean(),
  brandCited: z.boolean(),
  mentionPosition: z.number().int().nullable(),
  sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE"]).nullable(),
  competitorsMentioned: z
    .array(z.object({ name: z.string(), cited: z.boolean() }))
    .nullable(),
  citations: z.array(z.string()).nullable(),
  /** The engine's answer, kept as the evidence behind every parsed field. */
  answerText: z.string().nullable(),
  model: z.string(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: isoDateTime,
});

export type PromptResult = z.infer<typeof promptResultSchema>;

export const promptRunListSchema = z.object({
  data: z.array(promptRunSchema),
  nextCursor: z.string().nullable(),
});

export const promptResultListSchema = z.object({
  data: z.array(promptResultSchema),
  nextCursor: z.string().nullable(),
});

export const promptRunListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const promptResultQuerySchema = z.object({
  engine: z.string().max(40).optional(),
  promptTemplateId: z.string().uuid().optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
