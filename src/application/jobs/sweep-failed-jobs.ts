/**
 * The failed-job sweeper (docs/Backend.md §13): every 15 minutes, checks the pipeline's
 * own health and pages a human when it degrades — "alerts at >5% failure rate."
 */
import {
  SWEEPER_FAILURE_RATE_ALERT,
  SWEEPER_MIN_SAMPLE,
  SWEEPER_WINDOW_MINUTES,
} from "../../config/schedule.js";
import { sweeperAlertEmail } from "../../domain/notifications/templates.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { Mailer } from "../ports/mailer.port.js";
import type { JobRunsRepo } from "../../infrastructure/db/repositories/job-runs.repo.js";

export interface SweepFailedJobsDeps {
  readonly jobRuns: JobRunsRepo;
  readonly mailer: Mailer;
  readonly clock: Clock;
  /** No email is sent when unset — the alert still logs at error level either way. */
  readonly opsAlertEmail: string | null;
  readonly log: JobLogger;
}

export interface SweepFailedJobsResult {
  readonly total: number;
  readonly failed: number;
  readonly alerted: boolean;
}

export async function sweepFailedJobs(deps: SweepFailedJobsDeps): Promise<SweepFailedJobsResult> {
  const since = new Date(deps.clock.now().getTime() - SWEEPER_WINDOW_MINUTES * 60_000);
  const { total, failed } = await deps.jobRuns.failureRateSince(since);
  const rate = total === 0 ? 0 : failed / total;
  // A tiny sample makes any single failure look like a "100% failure rate" — the minimum
  // guards against paging a human over statistical noise.
  const alerted = total >= SWEEPER_MIN_SAMPLE && rate > SWEEPER_FAILURE_RATE_ALERT;

  if (alerted) {
    deps.log.error(
      { total, failed, rate, windowMinutes: SWEEPER_WINDOW_MINUTES },
      "failed-job rate exceeds threshold",
    );
    if (deps.opsAlertEmail !== null) {
      const email = sweeperAlertEmail({
        failureRate: rate,
        windowMinutes: SWEEPER_WINDOW_MINUTES,
        failed,
        total,
      });
      await deps.mailer.send({ to: deps.opsAlertEmail, ...email });
    }
  }

  return { total, failed, alerted };
}
