/**
 * The `recommendations` table (docs/Database.md §2.16).
 *
 * The interesting method is `upsertByFingerprint`. `(project_id, fingerprint)` is unique
 * in the schema, which is what turns a weekly re-crawl into an *update* rather than a
 * duplicate card — and the constraint, not the application, is what guarantees it. A race
 * between two crawls of the same project resolves in Postgres.
 */
import type { Database } from "../prisma.js";
import type {
  Recommendation,
  RecommendationDetail,
} from "../../../contracts/api/recommendations.js";
import { newUuidV7 } from "../uuid.js";

export type RecStatus = "OPEN" | "DONE" | "DISMISSED" | "VALIDATED" | "REGRESSED";
export type RecPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface UpsertRecommendation {
  readonly projectId: string;
  readonly fingerprint: string;
  readonly source: "RULE" | "AI";
  readonly ruleKey: string | null;
  readonly title: string;
  readonly body: string;
  readonly priority: RecPriority;
  readonly impact: number;
  readonly difficulty: number;
  readonly evidence: Record<string, unknown>;
  readonly crawlId: string;
}

interface RecRow {
  id: string;
  title: string;
  body: string;
  source: "RULE" | "AI";
  ruleKey: string | null;
  priority: RecPriority;
  impact: number;
  difficulty: number;
  status: RecStatus;
  evidence: unknown;
  firstSeenCrawlId: string | null;
  lastSeenCrawlId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const listSelect = {
  id: true,
  title: true,
  source: true,
  priority: true,
  impact: true,
  difficulty: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const detailSelect = {
  ...listSelect,
  body: true,
  ruleKey: true,
  evidence: true,
  firstSeenCrawlId: true,
  lastSeenCrawlId: true,
  resolvedAt: true,
} as const;

function toSummary(row: Omit<RecRow, "body" | "ruleKey" | "evidence" | "firstSeenCrawlId" | "lastSeenCrawlId" | "resolvedAt">): Recommendation {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    priority: row.priority,
    impact: row.impact,
    difficulty: row.difficulty,
    status: row.status,
    // `created_at` is when we first saw the issue; the card never resets it.
    firstSeenAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: RecRow): RecommendationDetail {
  return {
    ...toSummary(row),
    body: row.body,
    ruleKey: row.ruleKey,
    evidence: (row.evidence as Record<string, unknown> | null) ?? {},
    firstSeenCrawlId: row.firstSeenCrawlId,
    lastSeenCrawlId: row.lastSeenCrawlId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export class RecommendationsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Records a finding, creating it or refreshing the one already there.
   *
   * What an update deliberately does **not** touch: `status`, `created_at` and
   * `first_seen_crawl_id`. The user's decision about a card survives every re-crawl, and
   * "you have had this problem since March" is the most useful thing the card knows.
   *
   * What it does refresh: the wording, the counts, the evidence and `last_seen_crawl_id`,
   * because "three thin pages" becoming "seven thin pages" is the same issue getting worse.
   */
  async upsertByFingerprint(input: UpsertRecommendation): Promise<{ id: string; created: boolean }> {
    const existing = await this.#db.recommendation.findUnique({
      where: {
        projectId_fingerprint: { projectId: input.projectId, fingerprint: input.fingerprint },
      },
      select: { id: true },
    });

    if (existing !== null) {
      await this.#db.recommendation.update({
        where: { id: existing.id },
        data: {
          title: input.title,
          body: input.body,
          priority: input.priority,
          impact: input.impact,
          difficulty: input.difficulty,
          evidence: input.evidence as never,
          lastSeenCrawlId: input.crawlId,
        },
      });
      return { id: existing.id, created: false };
    }

    const row = await this.#db.recommendation.create({
      data: {
        id: newUuidV7(),
        projectId: input.projectId,
        fingerprint: input.fingerprint,
        source: input.source,
        ruleKey: input.ruleKey,
        title: input.title,
        body: input.body,
        priority: input.priority,
        impact: input.impact,
        difficulty: input.difficulty,
        evidence: input.evidence as never,
        firstSeenCrawlId: input.crawlId,
        lastSeenCrawlId: input.crawlId,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  }

  /** Fingerprints of a project's live cards — the input to "what did this crawl not see?" */
  async liveFingerprints(
    projectId: string,
  ): Promise<ReadonlyArray<{ id: string; fingerprint: string; status: RecStatus }>> {
    return this.#db.recommendation.findMany({
      where: { projectId, status: { notIn: ["DISMISSED"] } },
      select: { id: true, fingerprint: true, status: true },
    });
  }

  /** A pipeline-set transition: VALIDATED when an issue is gone, REGRESSED when it is back. */
  async setPipelineStatus(id: string, status: RecStatus, resolvedAt: Date | null): Promise<void> {
    await this.#db.recommendation.update({
      where: { id },
      data: { status, resolvedAt },
    });
  }

  async setClientStatus(id: string, status: RecStatus): Promise<RecommendationDetail> {
    const row = await this.#db.recommendation.update({
      where: { id },
      data: { status, resolvedAt: status === "DONE" ? new Date() : null },
      select: detailSelect,
    });
    return toDetail(row as RecRow);
  }

  async findInProject(projectId: string, id: string): Promise<RecommendationDetail | null> {
    const row = await this.#db.recommendation.findFirst({
      where: { id, projectId },
      select: detailSelect,
    });
    return row === null ? null : toDetail(row as RecRow);
  }

  /**
   * A project's recommendations.
   *
   * Ordered in the database by priority then leverage, so a paged read gets the same order
   * as an unpaged one — sorting in the application after a `LIMIT` would page through an
   * order nobody asked for.
   *
   * Index: `recommendations(project_id, status)`.
   */
  async listForProject(
    projectId: string,
    options: {
      readonly limit: number;
      readonly cursor?: string | undefined;
      readonly status?: RecStatus | undefined;
      readonly priority?: RecPriority | undefined;
    },
  ): Promise<readonly Recommendation[]> {
    const rows = await this.#db.recommendation.findMany({
      where: {
        projectId,
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      },
      orderBy: [{ priority: "asc" }, { impact: "desc" }, { difficulty: "asc" }, { id: "asc" }],
      take: options.limit,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      select: listSelect,
    });
    return rows.map((row) => toSummary(row as RecRow));
  }

  /** The dashboard's top block: the open cards worth doing first. */
  async topOpen(projectId: string, limit: number): Promise<readonly Recommendation[]> {
    return this.listForProject(projectId, { limit, status: "OPEN" });
  }

  /** New cards and resolved cards since `since` — the digest's "what changed" inputs. */
  async churnSince(
    projectId: string,
    since: Date,
  ): Promise<{ readonly opened: number; readonly resolved: number }> {
    const [opened, resolved] = await Promise.all([
      this.#db.recommendation.count({ where: { projectId, createdAt: { gte: since } } }),
      this.#db.recommendation.count({ where: { projectId, resolvedAt: { gte: since } } }),
    ]);
    return { opened, resolved };
  }
}
