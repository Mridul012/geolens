/**
 * The `job_runs` audit trail (docs/Database.md §2.18).
 *
 * Every job execution mirrors into Postgres, so queue history survives a Redis flush —
 * Redis holds operational state, never the record of what happened (Engineering-Rules §7).
 */
import type { Database } from "../prisma.js";
import { newUuidV7 } from "../uuid.js";

export type JobKind = "CRAWL" | "PROMPT_SIM" | "REPORT" | "DIGEST" | "CLEANUP" | "ROLLUP";
export type JobStatus = "QUEUED" | "ACTIVE" | "COMPLETED" | "FAILED" | "DELAYED" | "CANCELED";

export interface RecordQueuedInput {
  readonly kind: JobKind;
  readonly queue: string;
  readonly bullmqJobId: string;
  readonly projectId?: string | null;
  readonly refId?: string | null;
}

export interface JobRunSummary {
  readonly id: string;
  readonly kind: JobKind;
  readonly queue: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly projectId: string | null;
  readonly refId: string | null;
}

/** Failure text is written for a human reading an incident, so keep it readable but bounded. */
const MAX_ERROR_LENGTH = 2_000;

export class JobRunsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Upserts by `bullmq_job_id`: the recorder may see the same job again after a retry or a
   * redelivery, and a second audit row would misreport how often work actually ran.
   */
  async recordQueued(input: RecordQueuedInput): Promise<void> {
    const existing = await this.#db.jobRun.findFirst({
      where: { bullmqJobId: input.bullmqJobId, queue: input.queue },
      select: { id: true },
    });
    if (existing !== null) return;

    await this.#db.jobRun.create({
      data: {
        id: newUuidV7(),
        kind: input.kind,
        queue: input.queue,
        bullmqJobId: input.bullmqJobId,
        projectId: input.projectId ?? null,
        refId: input.refId ?? null,
        status: "QUEUED",
      },
    });
  }

  async markActive(queue: string, bullmqJobId: string, attempts: number): Promise<void> {
    await this.#db.jobRun.updateMany({
      where: { queue, bullmqJobId },
      data: { status: "ACTIVE", attempts, startedAt: new Date() },
    });
  }

  async markCompleted(queue: string, bullmqJobId: string): Promise<void> {
    await this.#db.jobRun.updateMany({
      where: { queue, bullmqJobId },
      data: { status: "COMPLETED", finishedAt: new Date(), error: null },
    });
  }

  async markFailed(
    queue: string,
    bullmqJobId: string,
    error: string,
    attempts: number,
  ): Promise<void> {
    await this.#db.jobRun.updateMany({
      where: { queue, bullmqJobId },
      data: {
        status: "FAILED",
        attempts,
        finishedAt: new Date(),
        error: error.slice(0, MAX_ERROR_LENGTH),
      },
    });
  }

  async recordProgress(queue: string, bullmqJobId: string, progress: unknown): Promise<void> {
    await this.#db.jobRun.updateMany({
      where: { queue, bullmqJobId },
      data: { progress: progress as never },
    });
  }

  /** Index: `job_runs(kind, status)`. */
  async listByStatus(status: JobStatus, limit: number): Promise<readonly JobRunSummary[]> {
    const rows = await this.#db.jobRun.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      queue: row.queue,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      projectId: row.projectId,
      refId: row.refId,
    }));
  }

  /**
   * Terminal outcomes since `since` — the failed-job sweeper's window (docs/Backend.md
   * §13). Only COMPLETED and FAILED are terminal; QUEUED/ACTIVE/DELAYED jobs are still in
   * flight and would understate a genuine spike if counted as "not failed" this instant.
   */
  async failureRateSince(
    since: Date,
  ): Promise<{ readonly total: number; readonly failed: number }> {
    const [total, failed] = await Promise.all([
      this.#db.jobRun.count({
        where: { createdAt: { gte: since }, status: { in: ["COMPLETED", "FAILED"] } },
      }),
      this.#db.jobRun.count({ where: { createdAt: { gte: since }, status: "FAILED" } }),
    ]);
    return { total, failed };
  }

  async findByBullmqId(queue: string, bullmqJobId: string): Promise<JobRunSummary | null> {
    const row = await this.#db.jobRun.findFirst({ where: { queue, bullmqJobId } });
    return row === null
      ? null
      : {
          id: row.id,
          kind: row.kind,
          queue: row.queue,
          status: row.status,
          attempts: row.attempts,
          error: row.error,
          projectId: row.projectId,
          refId: row.refId,
        };
  }
}
