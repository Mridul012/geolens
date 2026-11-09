/**
 * The append-only "what changed" feed (docs/Database.md §2.20, PRD FR-13.3).
 *
 * ── Raw SQL justification (Engineering-Rules §5) ──────────────────────────────
 * `events.id` is a bigint identity and the table is the first that offset pagination would
 * kill. Prisma's cursor pagination works, but the feed also needs a stable
 * `(created_at DESC, id DESC)` ordering with the cursor encoding both — Prisma cannot
 * express a compound cursor over a mixed-type tuple. The query below is parameterised;
 * nothing is string-built from input.
 */
import type { Database } from "../prisma.js";

export interface EventInput {
  readonly projectId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly crawlId?: string | null;
  readonly promptRunId?: string | null;
}

export interface EventRecord {
  /** bigint, string-encoded at the API boundary (Engineering-Rules §3). */
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly crawlId: string | null;
  readonly promptRunId: string | null;
  readonly createdAt: string;
}

interface EventRow {
  id: bigint;
  kind: string;
  payload: unknown;
  crawl_id: string | null;
  prompt_run_id: string | null;
  created_at: Date;
}

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id.toString(),
    kind: row.kind,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    crawlId: row.crawl_id,
    promptRunId: row.prompt_run_id,
    createdAt: row.created_at.toISOString(),
  };
}

export class EventsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async record(input: EventInput): Promise<EventRecord> {
    const row = await this.#db.event.create({
      data: {
        projectId: input.projectId,
        kind: input.kind,
        payload: input.payload as never,
        crawlId: input.crawlId ?? null,
        promptRunId: input.promptRunId ?? null,
      },
    });
    return toRecord({
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      crawl_id: row.crawlId,
      prompt_run_id: row.promptRunId,
      created_at: row.createdAt,
    });
  }

  async recordMany(inputs: readonly EventInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.#db.event.createMany({
      data: inputs.map((input) => ({
        projectId: input.projectId,
        kind: input.kind,
        payload: input.payload as never,
        crawlId: input.crawlId ?? null,
        promptRunId: input.promptRunId ?? null,
      })),
    });
  }

  /** How many events of `kind` this project logged since `since` — the digest's inputs. */
  async countSince(projectId: string, kind: string, since: Date): Promise<number> {
    return this.#db.event.count({ where: { projectId, kind, createdAt: { gte: since } } });
  }

  /**
   * Newest first, cursor-paginated on the identity id.
   *
   * Index: `events(project_id, created_at DESC)`; the id is monotonic within a project, so
   * ordering by id matches ordering by time without a second sort key.
   */
  async list(
    projectId: string,
    limit: number,
    cursor: string | undefined,
    kind: string | undefined,
  ): Promise<readonly EventRecord[]> {
    const cursorId = cursor === undefined ? null : BigInt(cursor);

    const rows = await this.#db.$queryRawUnsafe<EventRow[]>(
      `SELECT id, kind, payload, crawl_id, prompt_run_id, created_at
         FROM events
        WHERE project_id = $1::uuid
          AND ($2::bigint IS NULL OR id < $2::bigint)
          AND ($3::text IS NULL OR kind = $3::text)
        ORDER BY id DESC
        LIMIT $4::int`,
      projectId,
      cursorId,
      kind ?? null,
      limit,
    );

    return rows.map(toRecord);
  }
}
