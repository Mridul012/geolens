/**
 * `topic_coverage` (docs/Database.md §2.11) — one coverage fact per (crawl, topic).
 *
 * The composite primary key *is* the query pattern, so there is no id to generate and no
 * ordering to preserve: a crawl either has a coverage row for a topic or it does not.
 * Rows are immutable once a crawl finishes, which is what makes coverage history readable
 * months later even after the taxonomy has been edited.
 */
import type { Database } from "../prisma.js";

export interface CoverageWrite {
  readonly topicId: string;
  readonly coverageScore: number;
  readonly depthChunks: number;
  readonly evidence: {
    readonly chunkIds: readonly string[];
    readonly maxSimilarity: number | null;
    readonly thresholdsVersion: string;
  };
}

export interface StoredCoverage {
  readonly topicId: string;
  readonly coverageScore: number;
  readonly depthChunks: number;
  readonly evidence: Record<string, unknown> | null;
}

export class TopicCoverageRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Writes a crawl's coverage in one transaction.
   *
   * Replace rather than upsert: a re-run recomputes every topic, and leaving a stale row
   * for a topic the user archived between attempts would put a number on the dashboard
   * that no current topic explains.
   */
  async replaceForCrawl(crawlId: string, rows: readonly CoverageWrite[]): Promise<number> {
    return this.#db.$transaction(async (tx) => {
      await tx.topicCoverage.deleteMany({ where: { crawlId } });
      if (rows.length === 0) return 0;
      const created = await tx.topicCoverage.createMany({
        data: rows.map((row) => ({
          crawlId,
          topicId: row.topicId,
          coverageScore: row.coverageScore,
          depthChunks: row.depthChunks,
          evidence: {
            chunkIds: [...row.evidence.chunkIds],
            maxSimilarity: row.evidence.maxSimilarity,
            thresholdsVersion: row.evidence.thresholdsVersion,
          },
        })),
      });
      return created.count;
    });
  }

  /** Index: primary key `(crawl_id, topic_id)`. */
  async listForCrawl(crawlId: string): Promise<readonly StoredCoverage[]> {
    const rows = await this.#db.topicCoverage.findMany({
      where: { crawlId },
      select: { topicId: true, coverageScore: true, depthChunks: true, evidence: true },
    });
    return rows.map((row) => ({
      topicId: row.topicId,
      coverageScore: row.coverageScore,
      depthChunks: row.depthChunks,
      evidence: (row.evidence as Record<string, unknown> | null) ?? null,
    }));
  }
}
