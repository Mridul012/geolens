/**
 * Triggering a PDF report (docs/API.md §3 — `POST /reports`).
 *
 * The report pins its inputs at the moment it is requested: the latest completed crawl and
 * the latest completed prompt run, if any. The worker renders from exactly those ids, never
 * from "whatever is latest by the time the job runs" — a report is a record of what the
 * account looked like when the customer asked for one, not a live view.
 */
import { REPORT_SECTIONS, type Report, type ReportSection } from "../../contracts/api/reports.js";
import { limitsFor } from "../../config/plans.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { noCompletedCrawl, planLimitExceeded } from "../../domain/shared/app-error.js";
import type { JobQueue } from "../ports/job-queue.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";
import type { ReportsRepo } from "../../infrastructure/db/repositories/reports.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import { JOB_PRIORITY } from "../../config/queues.js";
import { jobId } from "../../contracts/jobs/index.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface StartReportDeps {
  readonly projects: ProjectsRepo;
  readonly sites: SitesRepo;
  readonly crawls: CrawlsRepo;
  readonly runs: PromptRunsRepo;
  readonly reports: ReportsRepo;
  readonly users: UsersRepo;
  readonly queue: JobQueue;
}

export interface StartReportInput {
  readonly projectId: string;
  readonly userId: string;
  readonly sections?: readonly ReportSection[] | undefined;
  readonly requestId?: string | undefined;
}

export async function startReport(
  deps: StartReportDeps,
  input: StartReportInput,
): Promise<Result<Report, AppError>> {
  const access = await assertProjectAccess(deps.projects, input.projectId, input.userId);
  if (!access.ok) return access;

  const plan = await deps.users.findPlan(input.userId);
  if (!limitsFor(plan).reports) {
    return err(planLimitExceeded(`PDF reports are not available on the ${plan} plan.`));
  }

  const ownSite = await deps.sites.findOwnSite(input.projectId);
  const crawlId = ownSite === null ? null : await deps.crawls.findLatestCompleted(ownSite.id);
  if (crawlId === null) return err(noCompletedCrawl());

  const promptRun = await deps.runs.findLatestCompleted(input.projectId);
  const sections = input.sections ?? REPORT_SECTIONS;

  const report = await deps.reports.create({
    projectId: input.projectId,
    kind: "ON_DEMAND",
    crawlId,
    promptRunId: promptRun?.id ?? null,
    sections,
  });

  await deps.queue.enqueue(
    "report",
    {
      reportId: report.id,
      projectId: input.projectId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
    { jobId: jobId.report(report.id), priority: JOB_PRIORITY.userTriggered },
  );

  return ok(report);
}
