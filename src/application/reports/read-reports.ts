/** Report reads (docs/API.md §3 — Reports: list, status). */
import type { Page } from "../../contracts/api/common.js";
import type { Report } from "../../contracts/api/reports.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { ReportsRepo } from "../../infrastructure/db/repositories/reports.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadReportsDeps {
  readonly projects: ProjectsRepo;
  readonly reports: ReportsRepo;
}

export async function listReports(
  deps: ReadReportsDeps,
  input: {
    readonly projectId: string;
    readonly userId: string;
    readonly limit: number;
    readonly cursor: string | undefined;
  },
): Promise<Result<Page<Report>, AppError>> {
  const access = await assertProjectAccess(deps.projects, input.projectId, input.userId);
  if (!access.ok) return access;

  const rows = await deps.reports.listForProject(input.projectId, input.limit + 1, input.cursor);
  const data = rows.slice(0, input.limit);
  return ok({ data, nextCursor: rows.length > input.limit ? (data.at(-1)?.id ?? null) : null });
}

export async function getReport(
  deps: ReadReportsDeps,
  projectId: string,
  userId: string,
  reportId: string,
): Promise<Result<Report, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const report = await deps.reports.findInProject(projectId, reportId);
  return report === null ? err(notFound("Report")) : ok(report);
}
