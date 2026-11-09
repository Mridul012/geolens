/**
 * Scheduling policy — cron patterns, offsets, and alert thresholds — in one place rather
 * than scattered across schedulers (Engineering-Rules §7, §15.6). All scheduling is BullMQ
 * job schedulers (docs/Backend.md §13); there is no external cron.
 */

/** Every hour, on the hour — fine enough granularity to hit any project's weekly slot. */
export const WEEKLY_TICK_CRON = "0 * * * *";
export const RETENTION_SWEEP_CRON = "0 3 * * *";
export const USAGE_ROLLUP_CRON = "0 * * * *";
export const FAILED_JOB_SWEEP_CRON = "*/15 * * * *";
export const BUDGET_MONITOR_CRON = "0 * * * *";

/** Hours after a project's weekly crawl slot that its prompt-sim and digest fire. */
export const PROMPT_SIM_OFFSET_HOURS = 4;
export const DIGEST_OFFSET_HOURS = 24;

/** The failed-job sweeper's window and alert threshold (docs/Backend.md §13). */
export const SWEEPER_WINDOW_MINUTES = 60;
export const SWEEPER_FAILURE_RATE_ALERT = 0.05;
/** Below this many terminal jobs in the window, a rate is noise, not a signal. */
export const SWEEPER_MIN_SAMPLE = 10;

/** The budget monitor's trailing window and warning ratio of the monthly ceiling. */
export const BUDGET_MONITOR_WINDOW_DAYS = 30;
export const BUDGET_WARNING_RATIO = 0.8;

export const SCHEDULER_IDS = Object.freeze({
  weeklyCrawls: "weekly-crawls",
  weeklyPromptRuns: "weekly-prompt-runs",
  weeklyDigests: "weekly-digests",
  retentionSweep: "retention-sweep",
  usageRollup: "usage-rollup",
  failedJobSweep: "failed-job-sweep",
  budgetMonitor: "budget-monitor",
});
