/**
 * Registers every BullMQ job scheduler (docs/Backend.md §13 — "all scheduling is BullMQ
 * repeatables; no external cron, no second scheduler to operate").
 *
 * `upsertJobScheduler` is keyed by a stable scheduler id: calling this on every worker boot
 * is what makes registration idempotent across restarts (M18 acceptance) — the same id
 * with the same repeat options updates the existing scheduler rather than creating a
 * second one, and BullMQ's own store is the single source of truth for what is scheduled.
 */
import {
  BUDGET_MONITOR_CRON,
  FAILED_JOB_SWEEP_CRON,
  RETENTION_SWEEP_CRON,
  SCHEDULER_IDS,
  USAGE_ROLLUP_CRON,
  WEEKLY_TICK_CRON,
} from "../../config/schedule.js";
import type { BullmqJobQueue } from "./bullmq-job-queue.js";
import type { HousekeepingJob } from "../../contracts/jobs/index.js";

async function schedule(
  queue: ReturnType<BullmqJobQueue["queueFor"]>,
  schedulerId: string,
  pattern: string,
  data: HousekeepingJob,
): Promise<void> {
  await queue.upsertJobScheduler(schedulerId, { pattern }, { name: "housekeeping", data });
}

export async function registerSchedules(jobQueue: BullmqJobQueue): Promise<void> {
  const housekeeping = jobQueue.queueFor("housekeeping");

  await Promise.all([
    schedule(housekeeping, SCHEDULER_IDS.weeklyCrawls, WEEKLY_TICK_CRON, {
      task: "schedule-weekly-crawls",
    }),
    schedule(housekeeping, SCHEDULER_IDS.weeklyPromptRuns, WEEKLY_TICK_CRON, {
      task: "schedule-weekly-prompt-runs",
    }),
    schedule(housekeeping, SCHEDULER_IDS.weeklyDigests, WEEKLY_TICK_CRON, {
      task: "schedule-weekly-digests",
    }),
    schedule(housekeeping, SCHEDULER_IDS.retentionSweep, RETENTION_SWEEP_CRON, {
      task: "sweep-deleted-projects",
    }),
    schedule(housekeeping, SCHEDULER_IDS.usageRollup, USAGE_ROLLUP_CRON, { task: "usage-rollup" }),
    schedule(housekeeping, SCHEDULER_IDS.failedJobSweep, FAILED_JOB_SWEEP_CRON, {
      task: "sweep-failed-jobs",
    }),
    schedule(housekeeping, SCHEDULER_IDS.budgetMonitor, BUDGET_MONITOR_CRON, {
      task: "budget-monitor",
    }),
  ]);
}
