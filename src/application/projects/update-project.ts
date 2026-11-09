/** Rename, retime or archive a project (docs/API.md §3 — PATCH /projects/{id}). */
import type { Project } from "../../contracts/api/projects.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { validationFailed } from "../../domain/shared/app-error.js";
import type { ProjectsRepo, ProjectUpdate } from "../../infrastructure/db/repositories/projects.repo.js";
import { assertProjectAccess } from "./assert-project-access.js";

export interface UpdateProjectDeps {
  readonly projects: ProjectsRepo;
}

/**
 * Timezones drive when scheduled crawls land (docs/Database.md §2.4), so an invalid one is
 * rejected at the boundary rather than silently defaulting a user into UTC mornings.
 */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function updateProject(
  deps: UpdateProjectDeps,
  projectId: string,
  userId: string,
  patch: ProjectUpdate,
): Promise<Result<Project, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
    return err(
      validationFailed([{ path: "timezone", message: "Not a recognised IANA time zone." }]),
    );
  }

  return ok(await deps.projects.update(projectId, patch));
}
