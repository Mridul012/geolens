/**
 * The housekeeping processor.
 *
 * Worker processors are controllers and peers of HTTP routes (Engineering-Rules §2.2):
 * validate the payload (the runtime already did), then call exactly one use case. No
 * business logic lives here.
 *
 * M18 adds the scheduler ticks and the housekeeping jobs proper (usage rollup, the failed-
 * job sweeper, the budget monitor) as further tasks on this same queue — each is a
 * no-payload, batch-process-everything-eligible job, the same shape `sweep-deleted-projects`
 * already established.
 */
import type { HousekeepingJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import { purgeProject, type PurgeProjectDeps } from "../../application/jobs/purge-project.js";
import { sweepDeletedProjects, type SweepDeps } from "../../application/jobs/sweep-deleted-projects.js";
import { rollUpUsage, type UsageRollupDeps } from "../../application/jobs/usage-rollup.js";
import {
  sweepFailedJobs,
  type SweepFailedJobsDeps,
} from "../../application/jobs/sweep-failed-jobs.js";
import { monitorBudgets, type BudgetMonitorDeps } from "../../application/jobs/budget-monitor.js";
import {
  scheduleWeeklyCrawls,
  type ScheduleWeeklyCrawlsDeps,
} from "../../application/scheduling/schedule-weekly-crawls.js";
import {
  scheduleWeeklyPromptRuns,
  type ScheduleWeeklyPromptRunsDeps,
} from "../../application/scheduling/schedule-weekly-prompt-runs.js";
import {
  scheduleWeeklyDigests,
  type ScheduleWeeklyDigestsDeps,
} from "../../application/scheduling/schedule-weekly-digests.js";
import { assertNever } from "../../domain/shared/result.js";

export interface HousekeepingDeps {
  readonly purge: PurgeProjectDeps;
  readonly sweep: SweepDeps;
  readonly scheduleWeeklyCrawls: Omit<ScheduleWeeklyCrawlsDeps, "log">;
  readonly scheduleWeeklyPromptRuns: Omit<ScheduleWeeklyPromptRunsDeps, "log">;
  readonly scheduleWeeklyDigests: ScheduleWeeklyDigestsDeps;
  readonly usageRollup: Omit<UsageRollupDeps, "log">;
  readonly sweepFailedJobs: Omit<SweepFailedJobsDeps, "log">;
  readonly budgetMonitor: Omit<BudgetMonitorDeps, "log">;
}

export function createHousekeepingProcessor(deps: HousekeepingDeps) {
  return async (job: HousekeepingJob, context: JobContext): Promise<void> => {
    switch (job.task) {
      case "purge-project": {
        const result = await purgeProject(
          {
            ...deps.purge,
            onProgress: (progress) => context.reportProgress(progress),
            shouldStop: context.shouldStop,
          },
          job.payload.projectId,
        );
        context.log.info(
          {
            projectId: result.projectId,
            completed: result.completed,
            objectsDeleted: result.objectsDeleted,
            deleted: Object.fromEntries(
              result.deletedByTable.map((row) => [row.table, row.deleted]),
            ),
          },
          result.completed ? "project purged" : "project purge paused for shutdown",
        );
        return;
      }
      case "sweep-deleted-projects": {
        const result = await sweepDeletedProjects(deps.sweep);
        context.log.info({ enqueued: result.enqueued }, "swept soft-deleted projects");
        return;
      }
      case "schedule-weekly-crawls": {
        const result = await scheduleWeeklyCrawls({ ...deps.scheduleWeeklyCrawls, log: context.log });
        context.log.info({ ...result }, "weekly crawl tick complete");
        return;
      }
      case "schedule-weekly-prompt-runs": {
        const result = await scheduleWeeklyPromptRuns({
          ...deps.scheduleWeeklyPromptRuns,
          log: context.log,
        });
        context.log.info({ ...result }, "weekly prompt-run tick complete");
        return;
      }
      case "schedule-weekly-digests": {
        const result = await scheduleWeeklyDigests(deps.scheduleWeeklyDigests);
        context.log.info({ ...result }, "weekly digest tick complete");
        return;
      }
      case "usage-rollup": {
        await rollUpUsage({ ...deps.usageRollup, log: context.log });
        return;
      }
      case "sweep-failed-jobs": {
        await sweepFailedJobs({ ...deps.sweepFailedJobs, log: context.log });
        return;
      }
      case "budget-monitor": {
        await monitorBudgets({ ...deps.budgetMonitor, log: context.log });
        return;
      }
      default:
        assertNever(job);
    }
  };
}
