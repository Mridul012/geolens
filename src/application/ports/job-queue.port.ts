/**
 * The job queue behind a port (Engineering-Rules §2.2). Use cases enqueue work; they never
 * import BullMQ, and they never learn whether the backing store is Redis.
 */
import type { JobPayloads } from "../../contracts/jobs/index.js";

export interface EnqueueOptions {
  /**
   * Deterministic id. Re-enqueueing the same id while the job is still queued or active is
   * a no-op, which is what makes double-clicks and retries safe.
   */
  readonly jobId: string;
  /** Lower is more urgent: user-triggered work outranks scheduled work. */
  readonly priority?: number;
  readonly delayMs?: number;
}

export interface JobQueue {
  enqueue<Q extends keyof JobPayloads>(
    queue: Q,
    payload: JobPayloads[Q],
    options: EnqueueOptions,
  ): Promise<void>;
}
