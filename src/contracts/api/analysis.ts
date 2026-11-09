/**
 * The analysis payload (docs/API.md §3 — AnalysisReport).
 *
 * Assembled across several milestones: the access check lands in M8, retrievability in M11,
 * the executive summary and technical issues in M12. Fields that have not been produced yet
 * are `null` or empty — the contract's honest empty state, never a fabricated value.
 */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

export const aiBotIdSchema = z.enum([
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "CCBot",
  "Bytespider",
]);

export const botFindingSchema = z.object({
  bot: aiBotIdSchema,
  operator: z.string(),
  allowed: z.boolean(),
  blockedBy: z.enum(["robots", "cdn"]).nullable(),
  /** The robots.txt line or HTTP comparison responsible. */
  evidence: z.string().nullable(),
  impact: z.string().nullable(),
  /** Copy-paste remediation; null when nothing is wrong. */
  fix: z.string().nullable(),
});

export const accessCheckSchema = z.object({
  bots: z.array(botFindingSchema),
  llmsTxt: z.object({
    present: z.boolean(),
    valid: z.boolean().nullable(),
    issues: z.array(z.string()),
  }),
  robotsTxtPresent: z.boolean(),
  allowedShare: z.number().int().min(0).max(100),
  checkedAt: isoDateTime,
});

export type AccessCheck = z.infer<typeof accessCheckSchema>;

/**
 * One question the simulation asked, and what came back (M11).
 *
 * `answered: null` means the judge could not be reached for this question — distinct from
 * "no", which is a verdict about the content.
 */
export const retrievabilityQuestionSchema = z.object({
  question: z.string(),
  topicLabel: z.string(),
  answered: z.enum(["fully", "partially", "no"]).nullable(),
  confidence: z.number().int().min(0).max(100).nullable(),
  missingElement: z.string().nullable(),
  /** The fused chunks this verdict was formed on — the evidence trail. */
  chunkIds: z.array(z.string()),
});

export const retrievabilitySchema = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  questionsTotal: z.number().int().min(0),
  questionsJudged: z.number().int().min(0),
  questionsAnswered: z.number().int().min(0),
  questionsPartial: z.number().int().min(0),
  questionsUnanswered: z.number().int().min(0),
  questions: z.array(retrievabilityQuestionSchema),
});

export type Retrievability = z.infer<typeof retrievabilitySchema>;

export const technicalIssueSchema = z.object({
  key: z.string(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  summary: z.string(),
});

export const analysisReportSchema = z.object({
  crawlId: uuidSchema,
  executiveSummary: z.string().nullable(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  accessCheck: accessCheckSchema.nullable(),
  /** Null when the simulation could not run; `degradation` carries the reason. */
  retrievability: retrievabilitySchema.nullable(),
  structuredDataHealth: z.record(z.unknown()).nullable(),
  technicalIssues: z.array(technicalIssueSchema),
  degradation: z.record(z.unknown()).nullable(),
});

export type AnalysisReport = z.infer<typeof analysisReportSchema>;
