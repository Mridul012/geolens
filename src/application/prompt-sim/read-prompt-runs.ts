/**
 * Prompt-run reads (docs/API.md §3 — Prompt Tracking).
 *
 * The per-cell results endpoint is the product's evidence surface: every parsed field is a
 * claim about an answer, and the answer is stored beside it so a customer disputing a
 * mention can read exactly what the engine said.
 */
import type { PromptResult, PromptRun } from "../../contracts/api/prompt-runs.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadPromptRunsDeps {
  readonly projects: ProjectsRepo;
  readonly runs: PromptRunsRepo;
}

export async function listPromptRuns(
  deps: ReadPromptRunsDeps,
  projectId: string,
  userId: string,
  options: { readonly limit: number; readonly cursor?: string | undefined },
): Promise<Result<{ data: readonly PromptRun[]; nextCursor: string | null }, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const rows = await deps.runs.listForProject(projectId, options.limit + 1, options.cursor);
  const page = rows.slice(0, options.limit);
  return ok({
    data: page,
    nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  });
}

export async function getPromptRun(
  deps: ReadPromptRunsDeps,
  projectId: string,
  userId: string,
  runId: string,
): Promise<Result<PromptRun, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const run = await deps.runs.findInProject(projectId, runId);
  return run === null ? err(notFound("Prompt run")) : ok(run);
}

export async function listPromptResults(
  deps: ReadPromptRunsDeps,
  projectId: string,
  userId: string,
  runId: string,
  options: {
    readonly limit: number;
    readonly cursor?: string | undefined;
    readonly engine?: string | undefined;
    readonly promptTemplateId?: string | undefined;
  },
): Promise<Result<{ data: readonly PromptResult[]; nextCursor: string | null }, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  // Scoped through the run to the project, so a run id from another tenant is not found.
  if ((await deps.runs.findInProject(projectId, runId)) === null) {
    return err(notFound("Prompt run"));
  }

  const rows = await deps.runs.listResults(runId, { ...options, limit: options.limit + 1 });
  const page = rows.slice(0, options.limit);
  return ok({
    data: page,
    nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  });
}

export interface TrendPoint {
  readonly runId: string;
  readonly at: string;
  readonly mentionRate: number | null;
  readonly citationShare: number | null;
  readonly perEngine: ReadonlyArray<{
    engine: string;
    mentionRate: number | null;
    citationShare: number | null;
  }>;
}

/**
 * The run trend, oldest first.
 *
 * Reads the stored metrics rather than recomputing from cells: the numbers a customer saw
 * last month must not move because the aggregation code changed since.
 */
export async function promptRunTrend(
  deps: ReadPromptRunsDeps,
  projectId: string,
  userId: string,
  limit: number,
): Promise<Result<readonly TrendPoint[], AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const runs = await deps.runs.listForProject(projectId, limit, undefined);
  const points = runs
    .filter((run) => run.status === "COMPLETED" || run.status === "COMPLETED_DEGRADED")
    .map((run) => {
      const perEngine = Array.isArray((run.metrics as { perEngine?: unknown } | null)?.perEngine)
        ? ((run.metrics as { perEngine: Array<Record<string, unknown>> }).perEngine)
        : [];
      return {
        runId: run.id,
        at: run.finishedAt ?? run.createdAt,
        mentionRate: run.mentionRate,
        citationShare: run.citationShare,
        perEngine: perEngine.map((engine) => ({
          engine: String(engine["engine"]),
          mentionRate: typeof engine["mentionRate"] === "number" ? engine["mentionRate"] : null,
          citationShare:
            typeof engine["citationShare"] === "number" ? engine["citationShare"] : null,
        })),
      };
    })
    .reverse();

  return ok(points);
}
