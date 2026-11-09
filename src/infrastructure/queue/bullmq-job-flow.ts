/**
 * The JobFlow port over BullMQ's `FlowProducer` (docs/Backend.md §5).
 *
 * Everything `BullmqJobQueue.enqueue` guarantees for a single job must hold for every node
 * of a flow too — payload validated against the contract, queue policy from config, and a
 * `job_runs` row in Postgres — otherwise half the pipeline would be unobservable the
 * moment it started fanning out.
 *
 * BullMQ's tree is inverted relative to how the pipeline reads: `children` run first and
 * the node itself is the fan-in. The port keeps that same shape, so `submit` is a direct
 * translation rather than a reordering.
 */
import { FlowProducer, type FlowJob } from "bullmq";
import type { FlowNode, JobFlow } from "../../application/ports/job-flow.port.js";
import type { JobPayloads } from "../../contracts/jobs/index.js";
import { JOB_SCHEMAS } from "../../contracts/jobs/index.js";
import { QUEUE_POLICIES, type QueueName } from "../../config/queues.js";
import type { JobKind, JobRunsRepo } from "../db/repositories/job-runs.repo.js";
import type { RedisClient } from "../redis/redis.js";
import { InvalidJobPayloadError } from "./bullmq-job-queue.js";

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

/** Flattened so every node's audit row is written before any of them can run. */
interface PendingRun {
  readonly queue: QueueName;
  readonly jobId: string;
  readonly projectId: string | null;
  readonly refId: string | null;
}

export class BullmqJobFlow implements JobFlow {
  readonly #producer: FlowProducer;
  readonly #jobRuns: JobRunsRepo;

  constructor(connection: RedisClient, jobRuns: JobRunsRepo) {
    this.#producer = new FlowProducer({ connection });
    this.#jobRuns = jobRuns;
  }

  async submit(root: FlowNode): Promise<void> {
    const pending: PendingRun[] = [];
    const tree = this.#toFlowJob(root, pending);

    // Audit rows first, for the same reason enqueue writes them first: a job in Redis with
    // no record in Postgres is invisible work (Engineering-Rules §7).
    for (const run of pending) {
      await this.#jobRuns.recordQueued({
        kind: QUEUE_KIND[run.queue],
        queue: run.queue,
        bullmqJobId: run.jobId,
        projectId: run.projectId,
        refId: run.refId,
      });
    }

    await this.#producer.add(tree);
  }

  #toFlowJob(node: FlowNode, pending: PendingRun[]): FlowJob {
    const queue = node.queue as QueueName;
    const schema = JOB_SCHEMAS[node.queue];
    const parsed = schema.safeParse(node.payload);
    if (!parsed.success) {
      throw new InvalidJobPayloadError(
        node.queue,
        parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n"),
      );
    }

    const staged = node.payload as JobPayloads["crawl" | "index" | "analyze" | "aggregate"];
    pending.push({
      queue,
      jobId: node.jobId,
      projectId: staged.projectId ?? null,
      refId: staged.crawlId ?? null,
    });

    const policy = QUEUE_POLICIES[queue];
    const children = (node.children ?? []).map((child) => this.#toFlowJob(child, pending));

    return {
      name: node.queue,
      queueName: node.queue,
      data: parsed.data,
      opts: {
        jobId: node.jobId,
        attempts: policy.attempts,
        backoff: { type: policy.backoff.type, delay: policy.backoff.delay },
        removeOnComplete: { count: policy.keepCompleted },
        removeOnFail: { count: policy.keepFailed },
        // Degrade, never hang. Without this a child that exhausts its retries leaves the
        // parent in `waiting-children` forever and the crawl never reaches a terminal
        // state; `failParentOnFailure` would be the opposite mistake, throwing away the
        // work that *did* succeed. Moving the failed child out of the dependency set lets
        // the fan-in run, notice what is missing, and flag the crawl degraded — which is
        // the partial-answer guarantee (AI-Pipeline §9) expressed in queue options.
        ignoreDependencyOnFailure: true,
        ...(node.priority === undefined ? {} : { priority: node.priority }),
      },
      ...(children.length === 0 ? {} : { children }),
    };
  }

  async close(): Promise<void> {
    await this.#producer.close();
  }
}
