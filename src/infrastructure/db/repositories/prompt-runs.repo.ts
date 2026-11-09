/**
 * Prompt runs and their per-cell results (docs/Database.md §2.13, §2.14).
 *
 * `prompt_results` carries a unique constraint on (run, prompt, engine, sample) — which is
 * what makes a retried cell job idempotent. A worker that dies after writing a cell and
 * before acknowledging the job will re-run it, and the constraint, not the application,
 * is what stops that becoming a duplicate row and a double-counted citation.
 */
import type { Database } from "../prisma.js";
import type { PromptRun, PromptResult } from "../../../contracts/api/prompt-runs.js";
import { newUuidV7 } from "../uuid.js";

export type PromptRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "COMPLETED_DEGRADED"
  | "FAILED";

export interface NewPromptRun {
  readonly projectId: string;
  readonly trigger: "MANUAL" | "SCHEDULED";
  readonly engines: readonly string[];
}

export interface CellResult {
  readonly promptRunId: string;
  readonly promptTemplateId: string;
  readonly engine: string;
  readonly sampleIndex: number;
  readonly brandMentioned: boolean;
  readonly brandCited: boolean;
  readonly mentionPosition: number | null;
  readonly competitorsMentioned: ReadonlyArray<{ name: string; cited: boolean }>;
  readonly citations: readonly string[];
  readonly answerText: string | null;
  readonly model: string;
  readonly latencyMs: number | null;
  readonly error: string | null;
}

interface RunRow {
  id: string;
  status: PromptRunStatus;
  trigger: "MANUAL" | "SCHEDULED";
  engines: string[];
  mentionRate: unknown;
  citationShare: unknown;
  metrics: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/** Prisma returns `Decimal` for numeric columns; the contract wants a plain number. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

function toRun(row: RunRow): PromptRun {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    engines: row.engines,
    mentionRate: toNumber(row.mentionRate),
    citationShare: toNumber(row.citationShare),
    metrics: (row.metrics as Record<string, unknown> | null) ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const runSelect = {
  id: true,
  status: true,
  trigger: true,
  engines: true,
  mentionRate: true,
  citationShare: true,
  metrics: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} as const;

/** Statuses the `one_active_run_per_project` partial unique index covers. */
export const ACTIVE_RUN_STATUSES: readonly PromptRunStatus[] = ["QUEUED", "RUNNING"];

export class PromptRunsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Creates a QUEUED run.
   *
   * A concurrent second attempt violates the partial unique index and surfaces as a unique
   * error — the database is the backstop, not an application check.
   */
  async create(input: NewPromptRun): Promise<PromptRun> {
    const row = await this.#db.promptRun.create({
      data: {
        id: newUuidV7(),
        projectId: input.projectId,
        trigger: input.trigger,
        engines: [...input.engines],
        status: "QUEUED",
      },
      select: runSelect,
    });
    return toRun(row as RunRow);
  }

  async findActiveForProject(projectId: string): Promise<PromptRun | null> {
    const row = await this.#db.promptRun.findFirst({
      where: { projectId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: runSelect,
    });
    return row === null ? null : toRun(row as RunRow);
  }

  /** The scheduler's "not twice in one week" guard, mirroring `CrawlsRepo.hasScheduledSince`. */
  async hasScheduledSince(projectId: string, since: Date): Promise<boolean> {
    const row = await this.#db.promptRun.findFirst({
      where: { projectId, trigger: "SCHEDULED", createdAt: { gte: since } },
      select: { id: true },
    });
    return row !== null;
  }

  async findInProject(projectId: string, runId: string): Promise<PromptRun | null> {
    const row = await this.#db.promptRun.findFirst({
      where: { id: runId, projectId },
      select: runSelect,
    });
    return row === null ? null : toRun(row as RunRow);
  }

  /** Index: `prompt_runs(project_id, created_at DESC)`. */
  async listForProject(
    projectId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<readonly PromptRun[]> {
    const rows = await this.#db.promptRun.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      select: runSelect,
    });
    return rows.map((row) => toRun(row as RunRow));
  }

  /** The latest run that produced numbers — what the dashboard and comparison read. */
  async findLatestCompleted(projectId: string): Promise<PromptRun | null> {
    const row = await this.#db.promptRun.findFirst({
      where: { projectId, status: { in: ["COMPLETED", "COMPLETED_DEGRADED"] } },
      orderBy: { createdAt: "desc" },
      select: runSelect,
    });
    return row === null ? null : toRun(row as RunRow);
  }

  async markRunning(runId: string): Promise<void> {
    await this.#db.promptRun.update({
      where: { id: runId },
      data: { status: "RUNNING", startedAt: new Date() },
    });
  }

  async finish(
    runId: string,
    status: Extract<PromptRunStatus, "COMPLETED" | "COMPLETED_DEGRADED" | "FAILED">,
    metrics: {
      readonly mentionRate: number | null;
      readonly citationShare: number | null;
      readonly metrics: Record<string, unknown> | null;
      readonly costUsdMicros: bigint;
    },
  ): Promise<PromptRun> {
    const row = await this.#db.promptRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        mentionRate: metrics.mentionRate,
        citationShare: metrics.citationShare,
        metrics: (metrics.metrics ?? undefined) as never,
        aiCostUsdMicros: metrics.costUsdMicros,
      },
      select: runSelect,
    });
    return toRun(row as RunRow);
  }

  /**
   * Records one sample.
   *
   * `skipDuplicates` rather than an upsert: a re-delivered cell job must not overwrite the
   * answer already recorded. The first write is the measurement; a second attempt asking
   * the same engine again would get a different answer, and silently replacing the stored
   * one would make the evidence disagree with the metric computed from it.
   */
  async recordCell(cell: CellResult): Promise<boolean> {
    const created = await this.#db.promptResult.createMany({
      data: [
        {
          promptRunId: cell.promptRunId,
          promptTemplateId: cell.promptTemplateId,
          engine: cell.engine,
          sampleIndex: cell.sampleIndex,
          brandMentioned: cell.brandMentioned,
          brandCited: cell.brandCited,
          mentionPosition: cell.mentionPosition,
          competitorsMentioned: cell.competitorsMentioned as never,
          citations: cell.citations as never,
          answerText: cell.answerText,
          model: cell.model,
          latencyMs: cell.latencyMs,
          error: cell.error,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  /** Every sample of a run — the input to aggregation. */
  async listSamples(runId: string): Promise<
    ReadonlyArray<{
      promptTemplateId: string;
      engine: string;
      sampleIndex: number;
      brandMentioned: boolean;
      brandCited: boolean;
      competitorsCited: readonly string[];
      failed: boolean;
    }>
  > {
    const rows = await this.#db.promptResult.findMany({
      where: { promptRunId: runId },
      select: {
        promptTemplateId: true,
        engine: true,
        sampleIndex: true,
        brandMentioned: true,
        brandCited: true,
        competitorsMentioned: true,
        error: true,
      },
    });

    return rows.map((row) => {
      const competitors = Array.isArray(row.competitorsMentioned)
        ? (row.competitorsMentioned as Array<{ name?: unknown; cited?: unknown }>)
        : [];
      return {
        promptTemplateId: row.promptTemplateId,
        engine: row.engine,
        sampleIndex: row.sampleIndex,
        brandMentioned: row.brandMentioned,
        brandCited: row.brandCited,
        competitorsCited: competitors.flatMap((competitor) =>
          competitor.cited === true && typeof competitor.name === "string"
            ? [competitor.name]
            : [],
        ),
        failed: row.error !== null,
      };
    });
  }

  /** Per-cell evidence, paged. */
  async listResults(
    runId: string,
    options: {
      readonly limit: number;
      readonly cursor?: string | undefined;
      readonly engine?: string | undefined;
      readonly promptTemplateId?: string | undefined;
    },
  ): Promise<readonly PromptResult[]> {
    const rows = await this.#db.promptResult.findMany({
      where: {
        promptRunId: runId,
        ...(options.engine === undefined ? {} : { engine: options.engine }),
        ...(options.promptTemplateId === undefined
          ? {}
          : { promptTemplateId: options.promptTemplateId }),
      },
      orderBy: { id: "asc" },
      take: options.limit,
      ...(options.cursor === undefined ? {} : { cursor: { id: BigInt(options.cursor) }, skip: 1 }),
    });

    return rows.map((row) => ({
      // bigint, string-encoded — the contract says so, and JSON cannot hold it otherwise.
      id: row.id.toString(),
      promptTemplateId: row.promptTemplateId,
      engine: row.engine,
      sampleIndex: row.sampleIndex,
      brandMentioned: row.brandMentioned,
      brandCited: row.brandCited,
      mentionPosition: row.mentionPosition,
      sentiment: row.sentiment,
      competitorsMentioned:
        (row.competitorsMentioned as Array<{ name: string; cited: boolean }> | null) ?? null,
      citations: (row.citations as string[] | null) ?? null,
      answerText: row.answerText,
      model: row.model,
      latencyMs: row.latencyMs,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async countResults(runId: string): Promise<number> {
    return this.#db.promptResult.count({ where: { promptRunId: runId } });
  }
}
