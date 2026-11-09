/**
 * BullMQ worker runtime (docs/Backend.md §6).
 *
 * Owns the four things every processor would otherwise re-implement: payload validation at
 * dequeue (a queue is a deploy boundary — §7), `job_runs` recording, structured logging
 * with the originating request id, and graceful drain on SIGTERM.
 */
import { Worker, type Job } from "bullmq";
import type { Logger } from "../telemetry/logger.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import type { JobPayloads } from "../../contracts/jobs/index.js";
import { JOB_SCHEMAS } from "../../contracts/jobs/index.js";
import { QUEUE_POLICIES, type QueueName, type WorkerPool } from "../../config/queues.js";
import { queuesForPool } from "../../config/queues.js";
import { referencesOf } from "./bullmq-job-queue.js";
import type { JobKind, JobRunsRepo } from "../db/repositories/job-runs.repo.js";
import type { RedisClient } from "../redis/redis.js";

export type Processor<Q extends keyof JobPayloads> = (
  payload: JobPayloads[Q],
  context: JobContext,
) => Promise<void>;

export type ProcessorMap = {
  readonly [Q in keyof JobPayloads]?: Processor<Q>;
};

const QUEUE_KIND: Readonly<Record<QueueName, JobKind>> = Object.freeze({
  crawl: "CRAWL",
  index: "CRAWL",
  analyze: "CRAWL",
  aggregate: "CRAWL",
  "prompt-sim": "PROMPT_SIM",
  report: "REPORT",
  notify: "DIGEST",
  housekeeping: "CLEANUP",
});

export class UnprocessableJobError extends Error {
  constructor(queue: string, issues: string) {
    super(`Job payload rejected by queue "${queue}":\n${issues}`);
    this.name = "UnprocessableJobError";
  }
}

export interface WorkerRuntimeOptions {
  readonly pool: WorkerPool;
  readonly connection: RedisClient;
  readonly jobRuns: JobRunsRepo;
  readonly logger: Logger;
  readonly processors: ProcessorMap;
}

export interface WorkerRuntime {
  readonly queues: readonly QueueName[];
  /** Stops claiming new jobs, lets in-flight work finish, then closes. */
  readonly drain: () => Promise<void>;
  readonly isDraining: () => boolean;
}

export function startWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  let draining = false;
  const workers: Worker[] = [];
  const started: QueueName[] = [];

  /**
   * Bookkeeping writes started by the `completed`/`failed` listeners.
   *
   * BullMQ's event listeners are synchronous, so the `job_runs` update they start cannot be
   * awaited by `close()`. Tracked here and awaited on drain instead: a job whose audit row
   * still said ACTIVE after a clean shutdown would be permanently invisible work, which is
   * the one thing §7 does not allow.
   */
  const bookkeeping = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    bookkeeping.add(work);
    void work.finally(() => bookkeeping.delete(work));
  };

  for (const name of queuesForPool(options.pool)) {
    const processor = options.processors[name as keyof JobPayloads];
    // A queue with no processor in this build simply is not consumed here — that is how a
    // milestone adds a pipeline stage without touching the runtime.
    if (processor === undefined) continue;

    const schema = JOB_SCHEMAS[name as keyof typeof JOB_SCHEMAS];
    const policy = QUEUE_POLICIES[name];

    const worker = new Worker(
      name,
      async (job: Job) => {
        const log = options.logger.child({
          queue: name,
          jobId: job.id ?? "unknown",
          attempt: job.attemptsMade + 1,
          ...(typeof (job.data as { requestId?: string }).requestId === "string"
            ? { requestId: (job.data as { requestId?: string }).requestId }
            : {}),
        });

        const parsed = schema.safeParse(job.data);
        if (!parsed.success) {
          // Fail loudly and readably rather than crashing mid-processor on a missing field.
          throw new UnprocessableJobError(
            name,
            parsed.error.issues
              .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
              .join("\n"),
          );
        }

        // A job scheduler's generated jobs never pass through `JobQueue.enqueue()`, so this
        // is the backstop that gives them a `job_runs` row too — `recordQueued` is already
        // idempotent (it no-ops if enqueue() got there first), so calling it here for every
        // job costs nothing extra for the common case.
        const references = referencesOf(
          name as keyof JobPayloads,
          parsed.data as JobPayloads[keyof JobPayloads],
        );
        await options.jobRuns.recordQueued({
          kind: QUEUE_KIND[name],
          queue: name,
          bullmqJobId: job.id ?? "unknown",
          projectId: references.projectId,
          refId: references.refId,
        });

        await options.jobRuns.markActive(name, job.id ?? "unknown", job.attemptsMade + 1);

        const context: JobContext = {
          jobId: job.id ?? "unknown",
          attempt: job.attemptsMade + 1,
          log,
          shouldStop: () => draining,
          reportProgress: async (progress: unknown) => {
            await job.updateProgress(progress as object);
            await options.jobRuns.recordProgress(name, job.id ?? "unknown", progress);
          },
        };

        const run = processor as Processor<keyof JobPayloads>;
        await run(parsed.data as JobPayloads[keyof JobPayloads], context);
      },
      {
        connection: options.connection,
        concurrency: policy.concurrency,
        lockDuration: policy.lockDurationSeconds * 1_000,
        ...(policy.limiter === undefined
          ? {}
          : { limiter: { max: policy.limiter.max, duration: policy.limiter.durationMs } }),
      },
    );

    worker.on("completed", (job) => {
      track(options.jobRuns.markCompleted(name, job.id ?? "unknown"));
      options.logger.info({ queue: name, jobId: job.id, kind: QUEUE_KIND[name] }, "job completed");
    });

    worker.on("failed", (job, error) => {
      const jobId = job?.id ?? "unknown";
      track(
        options.jobRuns.markFailed(name, jobId, error.message, (job?.attemptsMade ?? 0) + 1),
      );
      options.logger.error({ queue: name, jobId, err: error }, "job failed");
    });

    worker.on("error", (error) => {
      options.logger.error({ queue: name, err: error }, "worker error");
    });

    workers.push(worker);
    started.push(name);
  }

  return {
    queues: started,
    isDraining: () => draining,
    drain: async () => {
      draining = true;
      // `close()` stops claiming and waits for in-flight jobs — crawls checkpoint their
      // frontier at safe points and resume rather than restart (§7).
      await Promise.all(workers.map((worker) => worker.close()));
      // Then let the audit writes those jobs' completion events started actually land.
      await Promise.allSettled([...bookkeeping]);
    },
  };
}
