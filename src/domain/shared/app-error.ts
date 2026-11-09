/**
 * Typed errors — the shared kernel every layer speaks.
 *
 * Expected failures travel as `Result<T, AppError>` (Engineering-Rules §3); edges with no
 * use case to return through — the auth guard, the rate limiter — throw the same type.
 * Either way the HTTP error mapper turns it into problem+json with a stable `code`, so
 * clients never parse a message string.
 *
 * It lives in `domain/shared` rather than `application/` because ports, use cases and
 * edges all need to name it, and only the shared kernel is visible to all three.
 */
import type { ErrorCode } from "../../contracts/api/errors.js";

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly fields: readonly FieldError[] | undefined;
  /** Seconds until the caller may retry; surfaced as `Retry-After` for 429s. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    options: {
      readonly detail?: string;
      readonly fields?: readonly FieldError[];
      readonly retryAfterSeconds?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(options.detail ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.detail = options.detail;
    this.fields = options.fields;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

// ── Factories ───────────────────────────────────────────────────────────────
// Named after the situation rather than the code, so call sites read as prose.

export const authRequired = (detail = "Sign in to continue."): AppError =>
  new AppError("AUTH_REQUIRED", { detail });

export const invalidCredentials = (): AppError =>
  // Deliberately identical for "no such user" and "wrong password" — anything else is a
  // user-enumeration oracle.
  new AppError("INVALID_CREDENTIALS", { detail: "Email or password is incorrect." });

/** Missing, or not yours — indistinguishable by design (docs/API.md §4.2). */
export const notFound = (what = "Resource"): AppError =>
  new AppError("NOT_FOUND", { detail: `${what} not found.` });

export const planLimitExceeded = (detail: string): AppError =>
  new AppError("PLAN_LIMIT_EXCEEDED", { detail });

export const validationFailed = (fields: readonly FieldError[], detail?: string): AppError =>
  new AppError("VALIDATION_FAILED", {
    ...(detail === undefined ? {} : { detail }),
    fields,
  });

export const invalidUrl = (detail: string): AppError => new AppError("INVALID_URL", { detail });

export const emailInUse = (): AppError =>
  new AppError("EMAIL_IN_USE", { detail: "An account with that email already exists." });

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError("RATE_LIMITED", {
    detail: "Too many requests. Slow down and try again shortly.",
    retryAfterSeconds,
  });

export const crawlAlreadyActive = (): AppError =>
  new AppError("CRAWL_ALREADY_ACTIVE", {
    detail: "This site already has a crawl in progress.",
  });

export const promptRunAlreadyActive = (): AppError =>
  new AppError("PROMPT_RUN_ALREADY_ACTIVE", {
    detail: "This project already has a prompt run in progress.",
  });

export const idempotencyKeyReused = (): AppError =>
  new AppError("IDEMPOTENCY_KEY_REUSED", {
    detail: "That Idempotency-Key was already used with a different payload.",
  });

export const promptTextImmutable = (): AppError =>
  new AppError("PROMPT_TEXT_IMMUTABLE", {
    detail:
      "Prompt text cannot change — it would silently redefine the trend line. Archive this prompt and create a new one.",
  });

export const reportNotReady = (): AppError =>
  new AppError("REPORT_NOT_READY", { detail: "This report is still generating." });

export const noCompletedCrawl = (): AppError =>
  new AppError("NO_COMPLETED_CRAWL", {
    detail: "Run a crawl to completion before generating a report.",
  });

export const degraded = (detail: string): AppError => new AppError("DEGRADED", { detail });
