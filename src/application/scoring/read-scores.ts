/**
 * Score reads — history for the trend chart, and the latest score with its breakdown.
 *
 * Reads only. The write path is `compute-score.ts`, which is the sole writer of `scores`
 * (golden rule #2); putting the reads here keeps the whole scoring surface in one folder
 * without widening what that rule has to police.
 */
import type { Score } from "../../contracts/api/scores.js";
import type { Result } from "../../domain/shared/result.js";
import { ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadScoresDeps {
  readonly projects: ProjectsRepo;
  readonly scores: ScoresRepo;
}

export interface ScoreHistory {
  readonly data: readonly Score[];
  readonly nextCursor: string | null;
}

export async function listScores(
  deps: ReadScoresDeps,
  projectId: string,
  userId: string,
  options: {
    readonly limit: number;
    readonly cursor?: string | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  },
): Promise<Result<ScoreHistory, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  // One extra row tells us whether another page exists without a second count query.
  const rows = await deps.scores.listForProject(projectId, {
    limit: options.limit + 1,
    cursor: options.cursor,
    from: options.from === undefined ? undefined : new Date(options.from),
    to: options.to === undefined ? undefined : new Date(options.to),
  });

  const page = rows.slice(0, options.limit);
  return ok({
    data: page,
    nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  });
}

export interface ScoreBreakdown {
  /** Null before the first publishable score — "score pending", not an error. */
  readonly score: Score | null;
  /** The drawer payload: every component's value, weight, absence reason and evidence. */
  readonly components: Record<string, unknown> | null;
}

export async function latestScore(
  deps: ReadScoresDeps,
  projectId: string,
  userId: string,
): Promise<Result<ScoreBreakdown, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const latest = await deps.scores.findLatest(projectId);
  return ok({ score: latest?.score ?? null, components: latest?.components ?? null });
}
