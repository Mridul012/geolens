/**
 * Snapshot detail — the evidence view (docs/API.md §3).
 *
 * Trust is the product: every recommendation and every component of the score links to a
 * snapshot, and this is the endpoint that has to resolve. A recommendation whose evidence
 * 404s is worse than no recommendation.
 */
import type { PageSnapshotDetail } from "../../contracts/api/snapshots.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadSnapshotDeps {
  readonly projects: ProjectsRepo;
  readonly crawls: CrawlsRepo;
}

export async function getSnapshot(
  deps: ReadSnapshotDeps,
  projectId: string,
  userId: string,
  snapshotId: string,
): Promise<Result<PageSnapshotDetail, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const snapshot = await deps.crawls.findSnapshotInProject(projectId, snapshotId);
  return snapshot === null ? err(notFound("Snapshot")) : ok(snapshot);
}
