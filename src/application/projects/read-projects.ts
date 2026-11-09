/** Project reads: the cursor-paginated list and the detail view. */
import type { Page } from "../../contracts/api/common.js";
import type { Project, ProjectDetail } from "../../contracts/api/projects.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";

export interface ReadProjectsDeps {
  readonly projects: ProjectsRepo;
}

export async function listProjects(
  deps: ReadProjectsDeps,
  userId: string,
  limit: number,
  cursor: string | undefined,
): Promise<Page<Project>> {
  // Over-fetch by one to learn whether another page exists without a COUNT (§13).
  const rows = await deps.projects.listOwned(userId, limit + 1, cursor);
  const data = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (data.at(-1)?.id ?? null) : null;
  return { data, nextCursor };
}

export async function getProject(
  deps: ReadProjectsDeps,
  projectId: string,
  userId: string,
): Promise<Result<ProjectDetail, AppError>> {
  const detail = await deps.projects.findDetail(projectId, userId);
  return detail === null ? err(notFound("Project")) : ok(detail);
}
