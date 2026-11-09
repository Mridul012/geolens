/**
 * Soft-delete a project and schedule its purge (docs/API.md §3 — DELETE /projects/{id}).
 *
 * The response is `202 PURGE_SCHEDULED`, not `204`: derived rows go in batches on a worker
 * and R2 objects follow within the 30-day privacy SLA (PRD). Telling the user "deleted"
 * while gigabytes of snapshots still exist would be a lie in the UI.
 */
import type { Result } from "../../domain/shared/result.js";
import { ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { Clock } from "../ports/clock.port.js";
import { assertProjectAccess } from "./assert-project-access.js";

export interface DeleteProjectDeps {
  readonly projects: ProjectsRepo;
  readonly clock: Clock;
  /**
   * Enqueues the batched purge. Optional until M5 owns the queue: without it the project
   * is still soft-deleted and invisible, and the housekeeping sweep will collect it.
   */
  readonly schedulePurge?: (projectId: string) => Promise<void>;
}

export async function deleteProject(
  deps: DeleteProjectDeps,
  projectId: string,
  userId: string,
): Promise<Result<{ status: "PURGE_SCHEDULED" }, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  await deps.projects.softDelete(projectId, deps.clock.now());
  await deps.schedulePurge?.(projectId);

  return ok({ status: "PURGE_SCHEDULED" });
}
