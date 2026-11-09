/**
 * The weekly-digest tick (docs/Backend.md §13 — "after runs settle"), offset a day after
 * the project's crawl slot. This only enqueues; `application/notifications/send-digest.ts`
 * decides whether the week was quiet enough to skip the actual email.
 */
import { DIGEST_OFFSET_HOURS } from "../../config/schedule.js";
import { isDueThisHour, weekBucket } from "../../domain/scheduling/stagger.js";
import { jobId } from "../../contracts/jobs/index.js";
import { JOB_PRIORITY } from "../../config/queues.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobQueue } from "../ports/job-queue.port.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";

export interface ScheduleWeeklyDigestsDeps {
  readonly projects: ProjectsRepo;
  readonly queue: JobQueue;
  readonly clock: Clock;
}

export async function scheduleWeeklyDigests(
  deps: ScheduleWeeklyDigestsDeps,
): Promise<{ readonly enqueued: number }> {
  const now = deps.clock.now();
  const eligible = await deps.projects.listScheduledEligible();
  const week = weekBucket(now);

  let enqueued = 0;
  for (const project of eligible) {
    if (!isDueThisHour(project.projectId, project.timezone, now, DIGEST_OFFSET_HOURS)) continue;

    await deps.queue.enqueue(
      "notify",
      { task: "weekly-digest", payload: { projectId: project.projectId } },
      { jobId: jobId.notifyDigest(project.projectId, week), priority: JOB_PRIORITY.scheduled },
    );
    enqueued += 1;
  }

  return { enqueued };
}
