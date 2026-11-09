/**
 * The editable topic taxonomy (docs/Database.md §2.10).
 *
 * ── Raw SQL justification (Engineering-Rules §5) ──────────────────────────────
 * `topics.embedding` is `Unsupported("vector(1536)")`, so Prisma Client cannot read or
 * write it. The centroid write below is the only place that column is touched, and it is
 * parameterised — the vector is passed as a bound value, never interpolated.
 */
import type { Database } from "../prisma.js";
import { newUuidV7 } from "../uuid.js";

/** Buyer stage, mirroring `contracts/ai/taxonomy.ts`. Null for user-added topics (ADR 0004). */
export type TopicBuyerIntent = "awareness" | "consideration" | "decision";

export interface TopicRecord {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly source: "GENERATED" | "USER";
  readonly buyerIntent: TopicBuyerIntent | null;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly position: number;
}

export interface NewTopic {
  readonly label: string;
  readonly description: string | null;
  readonly source: "GENERATED" | "USER";
  /** Only the generator supplies this; the API's create-topic body has no field for it. */
  readonly buyerIntent?: TopicBuyerIntent | null;
  readonly position: number;
}

export interface TopicUpdate {
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly position?: number | undefined;
  readonly status?: "ACTIVE" | "ARCHIVED" | undefined;
}

const UNIQUE_VIOLATION = "P2002";

export function isDuplicateTopic(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? "";
  // The case-insensitive uniqueness is a partial expression index, which Prisma surfaces
  // as a raw constraint name rather than P2002.
  return code === UNIQUE_VIOLATION || message.includes("topics_project_label_ci");
}

interface TopicRow {
  id: string;
  label: string;
  description: string | null;
  source: "GENERATED" | "USER";
  buyerIntent: TopicBuyerIntent | null;
  status: "ACTIVE" | "ARCHIVED";
  position: number;
}

const select = {
  id: true,
  label: true,
  description: true,
  source: true,
  buyerIntent: true,
  status: true,
  position: true,
} as const;

function toRecord(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    source: row.source,
    buyerIntent: row.buyerIntent,
    status: row.status,
    position: row.position,
  };
}

export class TopicsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Index: `topics(project_id, status)`. */
  async listForProject(
    projectId: string,
    status?: "ACTIVE" | "ARCHIVED",
  ): Promise<readonly TopicRecord[]> {
    const rows = await this.#db.topic.findMany({
      where: { projectId, ...(status === undefined ? {} : { status }) },
      select,
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => toRecord(row as TopicRow));
  }

  async countActive(projectId: string): Promise<number> {
    return this.#db.topic.count({ where: { projectId, status: "ACTIVE" } });
  }

  async findInProject(projectId: string, topicId: string): Promise<TopicRecord | null> {
    const row = await this.#db.topic.findFirst({ where: { id: topicId, projectId }, select });
    return row === null ? null : toRecord(row as TopicRow);
  }

  async create(projectId: string, topic: NewTopic): Promise<TopicRecord> {
    const row = await this.#db.topic.create({
      data: {
        id: newUuidV7(),
        projectId,
        label: topic.label,
        description: topic.description,
        source: topic.source,
        buyerIntent: topic.buyerIntent ?? null,
        position: topic.position,
      },
      select,
    });
    return toRecord(row as TopicRow);
  }

  async update(topicId: string, patch: TopicUpdate): Promise<TopicRecord> {
    const row = await this.#db.topic.update({
      where: { id: topicId },
      data: {
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.position === undefined ? {} : { position: patch.position }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
      select,
    });
    return toRecord(row as TopicRow);
  }

  /**
   * Replaces a project's generated taxonomy in one transaction.
   *
   * Generated topics are archived rather than deleted: `topic_coverage` holds a Restrict FK
   * because historical coverage must stay interpretable (docs/Database.md §2.11). Topics
   * the user added are never touched — regenerating the taxonomy must not silently discard
   * their work.
   */
  async replaceGenerated(projectId: string, topics: readonly NewTopic[]): Promise<readonly TopicRecord[]> {
    return this.#db.$transaction(async (tx) => {
      await tx.topic.updateMany({
        where: { projectId, source: "GENERATED", status: "ACTIVE" },
        data: { status: "ARCHIVED" },
      });

      const created: TopicRecord[] = [];
      for (const topic of topics) {
        const row = await tx.topic.create({
          data: {
            id: newUuidV7(),
            projectId,
            label: topic.label,
            description: topic.description,
            source: topic.source,
            buyerIntent: topic.buyerIntent ?? null,
            position: topic.position,
          },
          select,
        });
        created.push(toRecord(row as TopicRow));
      }
      return created;
    });
  }

  /**
   * Stores a topic's embedding centroid, used to map chunks to topics (M10).
   *
   * Raw SQL because the column is `Unsupported` in Prisma; the vector is bound, not
   * interpolated.
   */
  async setEmbedding(topicId: string, embedding: readonly number[]): Promise<void> {
    await this.#db.$executeRawUnsafe(
      `UPDATE topics SET embedding = $2::vector WHERE id = $1::uuid`,
      topicId,
      `[${embedding.join(",")}]`,
    );
  }

  /** True when the topic has a stored centroid — coverage skips those that do not. */
  async hasEmbedding(topicId: string): Promise<boolean> {
    const rows = await this.#db.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT (embedding IS NOT NULL) AS present FROM topics WHERE id = $1::uuid`,
      topicId,
    );
    return rows[0]?.present ?? false;
  }
}
