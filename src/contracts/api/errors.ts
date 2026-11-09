/**
 * The stable error-code table from docs/API.md §1. Clients switch on `code`, never on
 * message text, so this union is a public contract: adding a code is additive, changing
 * or removing one is breaking.
 */
import { z } from "zod";

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "INVALID_URL",
  "AUTH_REQUIRED",
  "INVALID_CREDENTIALS",
  "PLAN_LIMIT_EXCEEDED",
  "PROMPT_TEXT_IMMUTABLE",
  "NOT_FOUND",
  "CRAWL_ALREADY_ACTIVE",
  "PROMPT_RUN_ALREADY_ACTIVE",
  "IDEMPOTENCY_KEY_REUSED",
  "EMAIL_IN_USE",
  "REPORT_NOT_READY",
  "NO_COMPLETED_CRAWL",
  "RATE_LIMITED",
  "DEGRADED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status for each code — the mapping documented in the contract's error table. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_FAILED: 400,
  INVALID_URL: 400,
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  PLAN_LIMIT_EXCEEDED: 403,
  PROMPT_TEXT_IMMUTABLE: 403,
  NOT_FOUND: 404,
  CRAWL_ALREADY_ACTIVE: 409,
  PROMPT_RUN_ALREADY_ACTIVE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  EMAIL_IN_USE: 409,
  REPORT_NOT_READY: 409,
  NO_COMPLETED_CRAWL: 409,
  RATE_LIMITED: 429,
  DEGRADED: 503,
  INTERNAL_ERROR: 500,
});

/** Human-readable titles; the `detail` field carries the specifics. */
export const ERROR_TITLE: Readonly<Record<ErrorCode, string>> = Object.freeze({
  VALIDATION_FAILED: "Validation failed",
  INVALID_URL: "Invalid URL",
  AUTH_REQUIRED: "Authentication required",
  INVALID_CREDENTIALS: "Invalid credentials",
  PLAN_LIMIT_EXCEEDED: "Plan limit exceeded",
  PROMPT_TEXT_IMMUTABLE: "Prompt text is immutable",
  NOT_FOUND: "Not found",
  CRAWL_ALREADY_ACTIVE: "Crawl already active",
  PROMPT_RUN_ALREADY_ACTIVE: "Prompt run already active",
  IDEMPOTENCY_KEY_REUSED: "Idempotency key reused",
  EMAIL_IN_USE: "Email already in use",
  REPORT_NOT_READY: "Report not ready",
  NO_COMPLETED_CRAWL: "No completed crawl",
  RATE_LIMITED: "Rate limited",
  DEGRADED: "Service degraded",
  INTERNAL_ERROR: "Internal server error",
});

/** RFC-7807 problem+json, with the machine-readable `code` the UI switches on. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(ERROR_CODES),
  detail: z.string().optional(),
  requestId: z.string().optional(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});

export type Problem = z.infer<typeof problemSchema>;

/** Kebab-cased code, as the contract's example `type` URI does. */
export function problemTypeUri(code: ErrorCode, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/errors/${code.toLowerCase().replaceAll("_", "-")}`;
}
