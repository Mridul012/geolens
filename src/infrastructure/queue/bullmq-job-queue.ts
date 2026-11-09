/**
 * The JobQueue port over BullMQ (docs/Backend.md §5).
 *
 * Enqueue does three things beyond handing Redis a payload: it validates against the job
 * contract, it applies the queue's policy from config, and it writes the `job_runs` audit
 * row — so a job that exists in Redis always exists in Postgres too.
 */
import { Queue } from "bullmq";
import type { JobQueue, EnqueueOptions } from "../../application/ports/job-queue.port.js";
import type { JobPayloads } from "../../contracts/jobs/index.js";
import { JOB_SCHEMAS } from "../../contracts/jobs/index.js";
import { QUEUE_POLICIES, type QueueName } from "../../config/queues.js";
import type { JobKind, JobRunsRepo } from "../db/repositories/job-runs.repo.js";
import type { RedisClient } from "../redis/redis.js";

/** Which `job_runs.kind` a queue's executions are recorded under. */
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

export class InvalidJobPayloadError extends Error {
  constructor(queue: string, issues: string) {
    super(`Invalid payload for queue "${queue}":\n${issues}`);
    this.name = "InvalidJobPayloadError";
  }
}

/**
 * Pulls the project/entity a job is about, for the audit row's soft references.
 *
 * Exported so `worker-runtime.ts` can back-fill a `job_runs` row for a job it did not
 * enqueue itself — a BullMQ job scheduler's generated jobs never pass through `enqueue()`
 * (Engineering-Rules §7's "a job in Redis always exists in Postgres" would otherwise not
 * hold for scheduled work).
 */
export function referencesOf(
  queue: keyof JobPayloads,
  payload: JobPayloads[keyof JobPayloads],
): { projectId: string | null; refId: string | null } {
  // Every pipeline stage is about one crawl, so they all reference it the same way.
  if (queue === "crawl" || queue === "index" || queue === "analyze" || queue === "aggregate") {
    const staged = payload as JobPayloads["crawl" | "index" | "analyze" | "aggregate"];
    return { projectId: staged.projectId, refId: staged.crawlId };
  }
  if (queue === "prompt-sim") {
    const run = payload as JobPayloads["prompt-sim"];
    return { projectId: run.projectId, refId: run.runId };
  }
  if (queue === "report") {
    const report = payload as JobPayloads["report"];
    return { projectId: report.projectId, refId: report.reportId };
  }
  if (queue === "notify") {
    const notify = payload as JobPayloads["notify"];
    return { projectId: notify.payload.projectId, refId: null };
  }
  const housekeeping = payload as JobPayloads["housekeeping"];
  if (housekeeping.task === "purge-project") {
    return { projectId: null, refId: housekeeping.payload.projectId };
  }
  return { projectId: null, refId: null };
}

export class BullmqJobQueue implements JobQueue {
  readonly #queues = new Map<string, Queue>();
  readonly #connection: RedisClient;
  readonly #jobRuns: JobRunsRepo;

  constructor(connection: RedisClient, jobRuns: JobRunsRepo) {
    this.#connection = connection;
    this.#jobRuns = jobRuns;
  }

  queueFor(name: QueueName): Queue {
    const existing = this.#queues.get(name);
    if (existing !== undefined) return existing;

    const policy = QUEUE_POLICIES[name];
    const queue = new Queue(name, {
      connection: this.#connection,
      defaultJobOptions: {
        attempts: policy.attempts,
        backoff: { type: policy.backoff.type, delay: policy.backoff.delay },
        removeOnComplete: { count: policy.keepCompleted },
        // Exhausted jobs stay in the failed set with their full error so the sweeper can
        // report a human-readable reason (Engineering-Rules §7).
        removeOnFail: { count: policy.keepFailed },
      },
    });
    this.#queues.set(name, queue);
    return queue;
  }

  async enqueue<Q extends keyof JobPayloads>(
    queue: Q,
    payload: JobPayloads[Q],
    options: EnqueueOptions,
  ): Promise<void> {
    const parsed = JOB_SCHEMAS[queue].safeParse(payload);
    if (!parsed.success) {
      throw new InvalidJobPayloadError(
        queue,
        parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n"),
      );
    }

    const references = referencesOf(queue, payload);
    // The audit row is written first: a job in Redis with no record in Postgres would be
    // invisible work, and §7 requires every execution to be observable.
    await this.#jobRuns.recordQueued({
      kind: QUEUE_KIND[queue as QueueName],
      queue,
      bullmqJobId: options.jobId,
      projectId: references.projectId,
      refId: references.refId,
    });

    await this.queueFor(queue as QueueName).add(queue, parsed.data, {
      jobId: options.jobId,
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((queue) => queue.close()));
    this.#queues.clear();
  }
}
