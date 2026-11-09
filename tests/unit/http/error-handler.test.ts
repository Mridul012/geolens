/**
 * The error mapper is the only place a failure becomes a status code, so its table is
 * worth asserting directly: a typed error in, the contract's problem+json out.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromZodError, normalizeError, toProblem } from "../../../src/http/plugins/error-handler.js";
import {
  AppError,
  crawlAlreadyActive,
  invalidCredentials,
  notFound,
  planLimitExceeded,
  promptTextImmutable,
  rateLimited,
} from "../../../src/domain/shared/app-error.js";
import { ERROR_CODES, ERROR_STATUS } from "../../../src/contracts/api/errors.js";

const BASE = "https://api.vryse.example/v1";

describe("toProblem", () => {
  it("renders the documented problem shape", () => {
    const problem = toProblem(planLimitExceeded("Free plan allows 1 project."), "req_123", BASE);
    expect(problem).toEqual({
      type: "https://api.vryse.example/v1/errors/plan-limit-exceeded",
      title: "Plan limit exceeded",
      status: 403,
      code: "PLAN_LIMIT_EXCEEDED",
      detail: "Free plan allows 1 project.",
      requestId: "req_123",
    });
  });

  it("includes field errors when the failure is field-level", () => {
    const problem = toProblem(
      fromZodError(z.object({ url: z.string().url() }).safeParse({ url: "nope" }).error!),
      "req_1",
      BASE,
    );
    expect(problem.code).toBe("VALIDATION_FAILED");
    expect(problem.errors).toEqual([{ path: "url", message: expect.any(String) }]);
  });

  it.each([
    [invalidCredentials(), 401, "INVALID_CREDENTIALS"],
    [notFound("Project"), 404, "NOT_FOUND"],
    [crawlAlreadyActive(), 409, "CRAWL_ALREADY_ACTIVE"],
    [promptTextImmutable(), 403, "PROMPT_TEXT_IMMUTABLE"],
    [rateLimited(30), 429, "RATE_LIMITED"],
  ] as const)("maps %# to its documented status", (error, status, code) => {
    const problem = toProblem(error, "req_1", BASE);
    expect(problem.status).toBe(status);
    expect(problem.code).toBe(code);
  });

  it("covers every code in the contract's table", () => {
    for (const code of ERROR_CODES) {
      const problem = toProblem(new AppError(code), "req_1", BASE);
      expect(problem.status).toBe(ERROR_STATUS[code]);
      expect(problem.title.length).toBeGreaterThan(0);
      expect(problem.type).toContain("/errors/");
      expect(problem.type).not.toContain("_");
    }
  });
});

describe("normalizeError", () => {
  it("passes an AppError through untouched", () => {
    const error = notFound("Crawl");
    expect(normalizeError(error)).toEqual({ app: error, unexpected: false });
  });

  it("treats a Zod failure as a client mistake, not a fault", () => {
    const zodError = z.object({ a: z.number() }).safeParse({ a: "x" }).error!;
    const result = normalizeError(zodError);
    expect(result.unexpected).toBe(false);
    expect(result.app.code).toBe("VALIDATION_FAILED");
  });

  it("treats Fastify's own validation failures as 400s", () => {
    const result = normalizeError({
      validation: [{ instancePath: "/body/email", message: "must match format" }],
      statusCode: 400,
    });
    expect(result.app.code).toBe("VALIDATION_FAILED");
    expect(result.app.fields).toEqual([{ path: "body.email", message: "must match format" }]);
  });

  it("maps an unknown throw to INTERNAL_ERROR without leaking its message", () => {
    const result = normalizeError(new Error("connection string: postgres://user:secret@host"));
    expect(result.unexpected).toBe(true);
    expect(result.app.code).toBe("INTERNAL_ERROR");
    expect(result.app.detail).not.toContain("secret");
  });

  it("maps a bare 404 to NOT_FOUND", () => {
    expect(normalizeError({ statusCode: 404 }).app.code).toBe("NOT_FOUND");
  });
});
