/**
 * Report download (docs/API.md §3 — `GET /reports/{id}/download`).
 *
 * The API never proxies PDF bytes (docs/API.md §4 — deliberate decision #7): it authorizes
 * and hands back a short-lived signed URL, and R2 does the serving.
 */
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound, reportNotReady } from "../../domain/shared/app-error.js";
import type { ObjectStorage } from "../ports/object-storage.port.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { ReportsRepo } from "../../infrastructure/db/repositories/reports.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface DownloadReportDeps {
  readonly projects: ProjectsRepo;
  readonly reports: ReportsRepo;
  readonly storage: ObjectStorage;
}

/** Long enough to complete a redirect and a download; short enough to not be a leak. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export async function downloadReport(
  deps: DownloadReportDeps,
  projectId: string,
  userId: string,
  reportId: string,
): Promise<Result<string, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const info = await deps.reports.downloadInfo(projectId, reportId);
  if (info === null) return err(notFound("Report"));
  if (info.status !== "READY" || info.storageKey === null) return err(reportNotReady());

  const url = await deps.storage.signedUrl(info.storageKey, DOWNLOAD_URL_TTL_SECONDS);
  return ok(url);
}
