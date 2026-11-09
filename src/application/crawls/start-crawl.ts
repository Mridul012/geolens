/**
 * Starting a crawl (docs/API.md §3 — POST /crawls).
 *
 * The HTTP handler never crawls: it validates, enqueues, and returns 202 with a Location
 * header (Engineering-Rules §4). Everything that could take longer than a request lives
 * behind the queue.
 */
import type { Crawl } from "../../contracts/api/crawls.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { crawlAlreadyActive, notFound, planLimitExceeded } from "../../domain/shared/app-error.js";
import { limitsFor } from "../../config/plans.js";
import { JOB_PRIORITY } from "../../config/queues.js";
import { jobId } from "../../contracts/jobs/index.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import type { JobQueue } from "../ports/job-queue.port.js";
import type { ProgressStore } from "../ports/progress-store.port.js";
import type { Clock } from "../ports/clock.port.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface StartCrawlDeps {
  readonly projects: ProjectsRepo;
  readonly sites: SitesRepo;
  readonly crawls: CrawlsRepo;
  readonly users: UsersRepo;
  readonly queue: JobQueue;
  readonly progress: ProgressStore;
  readonly clock: Clock;
}

export interface StartCrawlInput {
  readonly projectId: string;
  readonly userId: string;
  /** Defaults to the project's OWN site (docs/API.md §3). */
  readonly siteId?: string | undefined;
  readonly trigger?: "MANUAL" | "SCHEDULED";
  readonly requestId?: string | undefined;
}

/** Prisma's unique-violation code — the `one_active_crawl_per_site` backstop. */
const UNIQUE_VIOLATION = "P2002";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function startCrawl(
  deps: StartCrawlDeps,
  input: StartCrawlInput,
): Promise<Result<Crawl, AppError>> {
  const access = await assertProjectAccess(deps.projects, input.projectId, input.userId);
  if (!access.ok) return access;

  const site =
    input.siteId === undefined
      ? await deps.sites.findOwnSite(input.projectId)
      : await deps.sites.findInProject(input.projectId, input.siteId);
  if (site === null) return err(notFound("Site"));

  // Checked before the insert so the common case gets a clear 409 rather than a database
  // error; the partial unique index below is the race-proof backstop.
  const active = await deps.crawls.findActiveForSite(site.id);
  if (active !== null) return err(crawlAlreadyActive());

  const plan = await deps.users.findPlan(input.userId);
  const limits = limitsFor(plan);
  const trigger = input.trigger ?? "MANUAL";

  if (trigger === "SCHEDULED" && !limits.scheduledRuns) {
    return err(planLimitExceeded(`Scheduled crawls are not available on the ${plan} plan.`));
  }

  if (trigger === "MANUAL") {
    const since = new Date(deps.clock.now().getTime() - WEEK_MS);
    const recent = await deps.crawls.countManualSince(input.projectId, since);
    if (recent >= limits.onDemandCrawlsPerWeek) {
      return err(
        planLimitExceeded(
          `The ${plan} plan allows ${limits.onDemandCrawlsPerWeek} on-demand crawl${limits.onDemandCrawlsPerWeek === 1 ? "" : "s"} per week.`,
        ),
      );
    }
  }

  let crawl: Crawl;
  try {
    crawl = await deps.crawls.create({
      siteId: site.id,
      projectId: input.projectId,
      trigger,
    });
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      // Two requests raced; the database decided, and the loser gets the documented 409.
      return err(crawlAlreadyActive());
    }
    throw error;
  }

  await deps.progress.setCrawlProgress(crawl.id, {
    stage: "queued",
    message: "Queued — your crawl will start shortly.",
    pagesFound: 0,
    pagesCrawled: 0,
    currentUrl: null,
    etaSeconds: null,
    status: null,
  });

  await deps.queue.enqueue(
    "crawl",
    {
      crawlId: crawl.id,
      projectId: input.projectId,
      siteId: site.id,
      trigger,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
    {
      jobId: jobId.crawl(crawl.id),
      priority: trigger === "MANUAL" ? JOB_PRIORITY.userTriggered : JOB_PRIORITY.scheduled,
    },
  );

  return ok(crawl);
}
