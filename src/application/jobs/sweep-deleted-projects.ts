/**
 * Safety net for the purge.
 *
 * A project is soft-deleted the instant the user asks; the purge is then enqueued. If that
 * enqueue was lost — Redis down at exactly the wrong moment — this daily sweep finds the
 * orphan and re-enqueues it, so the 30-day privacy SLA does not depend on a single
 * best-effort write (PRD privacy NFR).
 */
import type { PurgeRepo } from "../../infrastructure/db/repositories/purge.repo.js";
import type { JobQueue } from "../ports/job-queue.port.js";
import type { Clock } from "../ports/clock.port.js";
import { jobId } from "../../contracts/jobs/index.js";
import { JOB_PRIORITY } from "../../config/queues.js";

export interface SweepDeps {
  readonly purge: PurgeRepo;
  readonly queue: JobQueue;
  readonly clock: Clock;
  readonly batchSize?: number | undefined;
}

export interface SweepResult {
  readonly enqueued: number;
}

export async function sweepDeletedProjects(deps: SweepDeps): Promise<SweepResult> {
  const projectIds = await deps.purge.findSoftDeleted(deps.clock.now(), deps.batchSize ?? 50);

  for (const projectId of projectIds) {
    // Deterministic job id: re-enqueueing an already-queued purge is a no-op, so a sweep
    // that overlaps a live purge cannot double it.
    await deps.queue.enqueue(
      "housekeeping",
      { task: "purge-project", payload: { projectId } },
      { jobId: jobId.purgeProject(projectId), priority: JOB_PRIORITY.housekeeping },
    );
  }

  return { enqueued: projectIds.length };
}
