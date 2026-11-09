/**
 * The `scores` table (docs/Database.md §2.15).
 *
 * ── Golden rule #2 ────────────────────────────────────────────────────────────
 * This repository owns the *statement*; `application/scoring/` owns the *decision*. The
 * rule the constitution greps for is that no caller outside `application/scoring/` writes
 * a score, so `insert` here has exactly one call site and the architecture test asserts it.
 * Reads are unrestricted — a score is meant to be looked at.
 */
import type { Database } from "../prisma.js";
import type { Score } from "../../../contracts/api/scores.js";
import { newUuidV7 } from "../uuid.js";

export interface NewScore {
  readonly projectId: string;
  readonly crawlId: string | null;
  readonly promptRunId: string | null;
  readonly composite: number;
  readonly citation: number | null;
  readonly retrievability: number | null;
  readonly contentQuality: number | null;
  readonly topicCoverage: number | null;
  readonly technical: number | null;
  readonly trust: number | null;
  /** The breakdown drawer payload, stored verbatim. */
  readonly components: Record<string, unknown>;
  readonly scoringConfigVersion: string;
}

export interface ScoreWithBreakdown {
  readonly score: Score;
  readonly components: Record<string, unknown> | null;
}

interface ScoreRow {
  id: string;
  composite: number;
  scoreCitation: number | null;
  scoreRetrievability: number | null;
  scoreContentQuality: number | null;
  scoreTopicCoverage: number | null;
  scoreTechnical: number | null;
  scoreTrust: number | null;
  crawlId: string | null;
  promptRunId: string | null;
  scoringConfigVersion: string;
  createdAt: Date;
}

function toScore(row: ScoreRow): Score {
  return {
    id: row.id,
    composite: row.composite,
    scoreCitation: row.scoreCitation,
    scoreRetrievability: row.scoreRetrievability,
    scoreContentQuality: row.scoreContentQuality,
    scoreTopicCoverage: row.scoreTopicCoverage,
    scoreTechnical: row.scoreTechnical,
    scoreTrust: row.scoreTrust,
    crawlId: row.crawlId,
    promptRunId: row.promptRunId,
    scoringConfigVersion: row.scoringConfigVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

const select = {
  id: true,
  composite: true,
  scoreCitation: true,
  scoreRetrievability: true,
  scoreContentQuality: true,
  scoreTopicCoverage: true,
  scoreTechnical: true,
  scoreTrust: true,
  crawlId: true,
  promptRunId: true,
  scoringConfigVersion: true,
  createdAt: true,
} as const;

export class ScoresRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Writes one score.
   *
   * Scores are append-only history — the trend chart *is* the table — so a re-scored crawl
   * replaces its own previous row rather than adding a second point for the same evidence.
   * That keeps "one score per crawl" true without making the write non-idempotent.
   */
  async insert(score: NewScore): Promise<Score> {
    return this.#db.$transaction(async (tx) => {
      if (score.crawlId !== null) {
        await tx.score.deleteMany({ where: { crawlId: score.crawlId } });
      }
      const row = await tx.score.create({
        data: {
          id: newUuidV7(),
          projectId: score.projectId,
          crawlId: score.crawlId,
          promptRunId: score.promptRunId,
          composite: score.composite,
          scoreCitation: score.citation,
          scoreRetrievability: score.retrievability,
          scoreContentQuality: score.contentQuality,
          scoreTopicCoverage: score.topicCoverage,
          scoreTechnical: score.technical,
          scoreTrust: score.trust,
          components: score.components as never,
          scoringConfigVersion: score.scoringConfigVersion,
        },
        select,
      });
      return toScore(row as ScoreRow);
    });
  }

  /** Index: `scores(project_id, created_at DESC)`. */
  async findLatest(projectId: string): Promise<ScoreWithBreakdown | null> {
    const row = await this.#db.score.findFirst({
      where: { projectId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { ...select, components: true },
    });
    if (row === null) return null;
    return {
      score: toScore(row as ScoreRow),
      components: (row.components as Record<string, unknown> | null) ?? null,
    };
  }

  async findForCrawl(crawlId: string): Promise<ScoreWithBreakdown | null> {
    const row = await this.#db.score.findFirst({
      where: { crawlId },
      select: { ...select, components: true },
    });
    if (row === null) return null;
    return {
      score: toScore(row as ScoreRow),
      components: (row.components as Record<string, unknown> | null) ?? null,
    };
  }

  /**
   * Score history for the trend chart, oldest→newest within the window.
   *
   * Cursor pagination, never OFFSET: this table grows one row per crawl per project
   * forever (docs/Database.md §7).
   */
  async listForProject(
    projectId: string,
    options: {
      readonly limit: number;
      readonly cursor?: string | undefined;
      readonly from?: Date | undefined;
      readonly to?: Date | undefined;
    },
  ): Promise<readonly Score[]> {
    const rows = await this.#db.score.findMany({
      where: {
        projectId,
        ...(options.from === undefined && options.to === undefined
          ? {}
          : {
              createdAt: {
                ...(options.from === undefined ? {} : { gte: options.from }),
                ...(options.to === undefined ? {} : { lte: options.to }),
              },
            }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.limit,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      select,
    });
    return rows.map((row) => toScore(row as ScoreRow));
  }

  /** The trend series the dashboard renders, newest last. */
  async recentTrend(
    projectId: string,
    limit: number,
  ): Promise<ReadonlyArray<{ date: string; composite: number }>> {
    const rows = await this.#db.score.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: { createdAt: true, composite: true },
    });
    return rows
      .map((row) => ({ date: row.createdAt.toISOString(), composite: row.composite }))
      .reverse();
  }
}
