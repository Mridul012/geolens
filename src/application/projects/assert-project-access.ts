/**
 * The ownership guard (Engineering-Rules §12).
 *
 * This is the first statement of every project-scoped use case. It lives in the
 * application layer rather than as an HTTP-only preHandler because workers are peers of
 * routes: a job that touches a project re-verifies state from the database and never
 * trusts its payload for authorization.
 *
 * A project that does not exist and a project owned by somebody else return the *same*
 * error. Returning 403 for the latter would confirm the resource exists — an existence
 * oracle that leaks customer names to anyone who can guess a UUID (docs/API.md §4.2).
 */
import type { Project } from "../../contracts/api/projects.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";

export async function assertProjectAccess(
  projects: ProjectsRepo,
  projectId: string,
  userId: string,
): Promise<Result<Project, AppError>> {
  const project = await projects.findOwned(projectId, userId);
  return project === null ? err(notFound("Project")) : ok(project);
}
