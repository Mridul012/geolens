/**
 * The single place a failure becomes an HTTP response (docs/API.md §1).
 *
 * Everything leaves as RFC-7807 `application/problem+json` with a stable `code` the UI
 * switches on. Unrecognised errors are 500s: logged with the stack, reported to Sentry,
 * and returned without internal detail — a leaked message is an information disclosure.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError, isAppError, validationFailed } from "../../domain/shared/app-error.js";
import {
  ERROR_STATUS,
  ERROR_TITLE,
  problemTypeUri,
  type ErrorCode,
  type Problem,
} from "../../contracts/api/errors.js";

export interface ErrorHandlerOptions {
  /** Base URL used to build the problem `type` URI. */
  readonly baseUrl: string;
  readonly onUnexpected?: (error: unknown, context: Record<string, unknown>) => void;
}

/** Zod's issue list maps directly onto the contract's `errors[]` field array. */
export function fromZodError(error: ZodError): AppError {
  return validationFailed(
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
    "One or more fields are invalid.",
  );
}

export function toProblem(error: AppError, requestId: string, baseUrl: string): Problem {
  const status = ERROR_STATUS[error.code];
  return {
    type: problemTypeUri(error.code, baseUrl),
    title: ERROR_TITLE[error.code],
    status,
    code: error.code,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    requestId,
    ...(error.fields === undefined ? {} : { errors: [...error.fields] }),
  };
}

/**
 * Normalises anything thrown anywhere into an AppError.
 *
 * Fastify's own validation failures arrive as plain errors carrying a `validation` array;
 * they are client mistakes, not faults, and must not become 500s.
 */
export function normalizeError(error: unknown): { app: AppError; unexpected: boolean } {
  if (isAppError(error)) return { app: error, unexpected: false };
  if (error instanceof ZodError) return { app: fromZodError(error), unexpected: false };

  const candidate = error as {
    validation?: ReadonlyArray<{ instancePath?: string; message?: string }>;
    statusCode?: number;
    code?: string;
  };
  if (Array.isArray(candidate.validation)) {
    return {
      app: validationFailed(
        candidate.validation.map((issue) => ({
          path: (issue.instancePath ?? "").replace(/^\//, "").replaceAll("/", "."),
          message: issue.message ?? "Invalid value",
        })),
        "One or more fields are invalid.",
      ),
      unexpected: false,
    };
  }
  if (candidate.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || candidate.statusCode === 400) {
    return {
      app: validationFailed([{ path: "body", message: "Malformed request body." }]),
      unexpected: false,
    };
  }
  if (candidate.statusCode === 404) {
    return { app: new AppError("NOT_FOUND", { detail: "Route not found." }), unexpected: false };
  }
  return {
    app: new AppError("INTERNAL_ERROR", {
      detail: "Something went wrong on our side. The failure has been recorded.",
      cause: error,
    }),
    unexpected: true,
  };
}

export function registerErrorHandler(app: FastifyInstance, options: ErrorHandlerOptions): void {
  const send = (request: FastifyRequest, reply: FastifyReply, error: AppError): FastifyReply => {
    const problem = toProblem(error, String(request.id), options.baseUrl);
    if (error.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(error.retryAfterSeconds));
    }
    return reply.code(problem.status).type("application/problem+json").send(problem);
  };

  app.setErrorHandler((error, request, reply) => {
    const { app: appError, unexpected } = normalizeError(error);
    if (unexpected) {
      request.log.error({ err: error }, "unhandled error");
      options.onUnexpected?.(error, { requestId: request.id, url: request.url });
    } else {
      request.log.info({ code: appError.code, detail: appError.detail }, "request failed");
    }
    return send(request, reply, appError);
  });

  app.setNotFoundHandler((request, reply) =>
    send(request, reply, new AppError("NOT_FOUND", { detail: "Route not found." })),
  );
}

export type { ErrorCode };
