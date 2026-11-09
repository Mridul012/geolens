/**
 * The `ai_usage` metering ledger (docs/Database.md §2.19, Engineering-Rules §6).
 *
 * Every model call writes a row: purpose, provider, model, tokens, cost, latency. A call
 * without a ledger row is a bug — this is how per-project unit economics stay answerable
 * and how the budget code knows what has been spent.
 *
 * Rows survive project deletion with their references nulled: it is a financial record,
 * not derived data (§1.6).
 */
import type { Database } from "../prisma.js";

export interface UsageRecord {
  readonly projectId?: string | null;
  readonly crawlId?: string | null;
  readonly promptRunId?: string | null;
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsdMicros: bigint;
  readonly latencyMs: number;
}

export class AiUsageRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async record(usage: UsageRecord): Promise<void> {
    await this.#db.aiUsage.create({
      data: {
        projectId: usage.projectId ?? null,
        crawlId: usage.crawlId ?? null,
        promptRunId: usage.promptRunId ?? null,
        purpose: usage.purpose,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costUsdMicros: usage.costUsdMicros,
        latencyMs: usage.latencyMs,
      },
    });
  }

  /**
   * Total spend attributed to one crawl — the budget pre-check's input.
   *
   * Index: `ai_usage(crawl_id)`.
   */
  async totalForCrawl(crawlId: string): Promise<bigint> {
    const result = await this.#db.aiUsage.aggregate({
      where: { crawlId },
      _sum: { costUsdMicros: true },
    });
    return result._sum.costUsdMicros ?? 0n;
  }

  async totalForPromptRun(promptRunId: string): Promise<bigint> {
    const result = await this.#db.aiUsage.aggregate({
      where: { promptRunId },
      _sum: { costUsdMicros: true },
    });
    return result._sum.costUsdMicros ?? 0n;
  }

  /** Trailing spend for one project — the budget monitor's input. */
  async totalForProjectSince(projectId: string, since: Date): Promise<bigint> {
    const result = await this.#db.aiUsage.aggregate({
      where: { projectId, createdAt: { gte: since } },
      _sum: { costUsdMicros: true },
    });
    return result._sum.costUsdMicros ?? 0n;
  }

  /** Call counts by purpose — what the golden evals assert against. */
  async countsByPurpose(crawlId: string): Promise<Readonly<Record<string, number>>> {
    const rows = await this.#db.aiUsage.groupBy({
      by: ["purpose"],
      where: { crawlId },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((row) => [row.purpose, row._count._all]));
  }
}
