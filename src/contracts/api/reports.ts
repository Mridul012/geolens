/** Report payloads (docs/API.md §3 — Reports). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

/** Defaults to all five when the request omits `sections`. */
export const REPORT_SECTIONS = [
  "summary",
  "score",
  "trends",
  "recommendations",
  "comparison",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const generateReportSchema = z.object({
  sections: z.array(z.enum(REPORT_SECTIONS)).min(1).optional(),
});
export type GenerateReportInput = z.infer<typeof generateReportSchema>;

export const reportKindSchema = z.enum(["ON_DEMAND", "SCHEDULED"]);
export const reportStatusSchema = z.enum(["QUEUED", "GENERATING", "READY", "FAILED"]);

export const reportSchema = z.object({
  id: uuidSchema,
  kind: reportKindSchema,
  status: reportStatusSchema,
  crawlId: uuidSchema.nullable(),
  promptRunId: uuidSchema.nullable(),
  sizeBytes: z.number().int().nullable(),
  generatedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type Report = z.infer<typeof reportSchema>;
