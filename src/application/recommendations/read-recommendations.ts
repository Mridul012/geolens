/**
 * Recommendation reads and the one transition a client owns (docs/API.md §3).
 *
 * `VALIDATED` and `REGRESSED` never appear here as inputs. They are set by the pipeline
 * when a later crawl proves an issue fixed or finds it again, and the value of "we checked
 * and it is actually gone" evaporates the moment a client can assert it.
 */
import type {
  Recommendation,
  RecommendationDetail,
} from "../../contracts/api/recommendations.js";
import { canClientTransition } from "../../domain/recommendations/status.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound, validationFailed } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type {
  RecPriority,
  RecStatus,
  RecommendationsRepo,
} from "../../infrastructure/db/repositories/recommendations.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface RecommendationDeps {
  readonly projects: ProjectsRepo;
  readonly recommendations: RecommendationsRepo;
}

export interface RecommendationPage {
  readonly data: readonly Recommendation[];
  readonly nextCursor: string | null;
}

export async function listRecommendations(
  deps: RecommendationDeps,
  projectId: string,
  userId: string,
  options: {
    readonly limit: number;
    readonly cursor?: string | undefined;
    readonly status?: RecStatus | undefined;
    readonly priority?: RecPriority | undefined;
  },
): Promise<Result<RecommendationPage, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  // One extra row answers "is there another page" without a second count query.
  const rows = await deps.recommendations.listForProject(projectId, {
    ...options,
    limit: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  return ok({
    data: page,
    nextCursor: rows.length > options.limit ? (page.at(-1)?.id ?? null) : null,
  });
}

export async function getRecommendation(
  deps: RecommendationDeps,
  projectId: string,
  userId: string,
  recId: string,
): Promise<Result<RecommendationDetail, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const row = await deps.recommendations.findInProject(projectId, recId);
  return row === null ? err(notFound("Recommendation")) : ok(row);
}

export async function updateRecommendationStatus(
  deps: RecommendationDeps,
  projectId: string,
  userId: string,
  recId: string,
  status: RecStatus,
): Promise<Result<RecommendationDetail, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const current = await deps.recommendations.findInProject(projectId, recId);
  if (current === null) return err(notFound("Recommendation"));

  const rejection = canClientTransition(current.status, status);
  if (rejection !== null) {
    return err(validationFailed([{ path: "status", message: rejection.detail }]));
  }

  return ok(await deps.recommendations.setClientStatus(recId, status));
}
