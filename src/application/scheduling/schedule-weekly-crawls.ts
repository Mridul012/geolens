/**
 * The weekly-crawl tick (docs/Backend.md §13). Runs hourly and, for every PRO project
 * whose stagger slot matches this hour, starts a SCHEDULED crawl through the exact same
 * use case an on-demand click goes through — the tick is just a different caller, not a
 * second implementation of "start a crawl."
 */
import { isDueThisHour } from "../../domain/scheduling/stagger.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import { startCrawl, type StartCrawlDeps } from "../crawls/start-crawl.js";

export interface ScheduleWeeklyCrawlsDeps extends StartCrawlDeps {
  readonly projects: ProjectsRepo;
  readonly crawls: CrawlsRepo;
  readonly clock: Clock;
  readonly log: JobLogger;
}

export interface ScheduleWeeklyCrawlsResult {
  readonly scheduled: number;
  readonly skipped: number;
}

/** Guards against firing twice for the same weekly slot (a re-run tick, a restart). */
const DEDUPE_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

export async function scheduleWeeklyCrawls(
  deps: ScheduleWeeklyCrawlsDeps,
): Promise<ScheduleWeeklyCrawlsResult> {
  const now = deps.clock.now();
  const since = new Date(now.getTime() - DEDUPE_WINDOW_MS);
  const eligible = await deps.projects.listScheduledEligible();

  let scheduled = 0;
  let skipped = 0;

  for (const project of eligible) {
    if (!isDueThisHour(project.projectId, project.timezone, now)) continue;

    if (await deps.crawls.hasScheduledSince(project.ownSiteId, since)) {
      skipped += 1;
      continue;
    }

    const result = await startCrawl(deps, {
      projectId: project.projectId,
      userId: project.userId,
      siteId: project.ownSiteId,
      trigger: "SCHEDULED",
    });

    if (!result.ok) {
      // Most commonly CRAWL_ALREADY_ACTIVE — an on-demand crawl the customer kicked off
      // is already running. The tick moves on; next week's slot tries again.
      deps.log.info(
        { projectId: project.projectId, code: result.error.code },
        "scheduled crawl skipped",
      );
      skipped += 1;
      continue;
    }

    scheduled += 1;
  }

  return { scheduled, skipped };
}
