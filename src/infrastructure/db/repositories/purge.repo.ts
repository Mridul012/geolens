/**
 * Batched deletion for the project purge (docs/Database.md §1.6).
 *
 * ── Raw SQL justification (Engineering-Rules §5) ──────────────────────────────
 * Postgres supports `DELETE ... WHERE id IN (SELECT ... LIMIT n)`; Prisma's `deleteMany`
 * has no `LIMIT`. A project can carry tens of thousands of snapshot rows, and an
 * unbounded cascade would hold locks on hot tables for the length of the delete — at
 * exactly the moment the user is watching the UI. Every statement below is parameterised;
 * table names are compile-time literals, never interpolated from input.
 */
import type { Database } from "../prisma.js";
import { PURGE_BATCH_SIZE } from "../../../config/queues.js";

export interface PurgeProgress {
  readonly table: string;
  readonly deleted: number;
}

/** Child tables in dependency order — Restrict FKs (results→templates, coverage→topics)
 *  mean the order here is load-bearing, not cosmetic. */
type BatchStep = {
  readonly table: string;
  readonly sql: (limit: number) => { text: string; values: readonly unknown[] };
};

function steps(projectId: string): readonly BatchStep[] {
  const p = projectId;
  return [
    {
      table: "chunks",
      sql: (limit) => ({
        text: `DELETE FROM chunks WHERE id IN (
                 SELECT c.id FROM chunks c
                 JOIN crawls cr ON cr.id = c.crawl_id
                 WHERE cr.project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "page_snapshots",
      sql: (limit) => ({
        text: `DELETE FROM page_snapshots WHERE id IN (
                 SELECT s.id FROM page_snapshots s
                 JOIN crawls cr ON cr.id = s.crawl_id
                 WHERE cr.project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "topic_coverage",
      sql: (limit) => ({
        text: `DELETE FROM topic_coverage WHERE (crawl_id, topic_id) IN (
                 SELECT tc.crawl_id, tc.topic_id FROM topic_coverage tc
                 JOIN crawls cr ON cr.id = tc.crawl_id
                 WHERE cr.project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "prompt_results",
      sql: (limit) => ({
        text: `DELETE FROM prompt_results WHERE id IN (
                 SELECT pr.id FROM prompt_results pr
                 JOIN prompt_runs r ON r.id = pr.prompt_run_id
                 WHERE r.project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "pages",
      sql: (limit) => ({
        text: `DELETE FROM pages WHERE id IN (
                 SELECT pg.id FROM pages pg
                 JOIN sites s ON s.id = pg.site_id
                 WHERE s.project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "scores",
      sql: (limit) => ({
        text: `DELETE FROM scores WHERE id IN (
                 SELECT id FROM scores WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "recommendations",
      sql: (limit) => ({
        text: `DELETE FROM recommendations WHERE id IN (
                 SELECT id FROM recommendations WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "reports",
      sql: (limit) => ({
        text: `DELETE FROM reports WHERE id IN (
                 SELECT id FROM reports WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "events",
      sql: (limit) => ({
        text: `DELETE FROM events WHERE id IN (
                 SELECT id FROM events WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "crawls",
      sql: (limit) => ({
        text: `DELETE FROM crawls WHERE id IN (
                 SELECT id FROM crawls WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "prompt_runs",
      sql: (limit) => ({
        text: `DELETE FROM prompt_runs WHERE id IN (
                 SELECT id FROM prompt_runs WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "prompt_templates",
      sql: (limit) => ({
        text: `DELETE FROM prompt_templates WHERE id IN (
                 SELECT id FROM prompt_templates WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "topics",
      sql: (limit) => ({
        text: `DELETE FROM topics WHERE id IN (
                 SELECT id FROM topics WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
    {
      table: "sites",
      sql: (limit) => ({
        text: `DELETE FROM sites WHERE id IN (
                 SELECT id FROM sites WHERE project_id = $1::uuid LIMIT ${limit})`,
        values: [p],
      }),
    },
  ];
}

export interface PurgeRepoOptions {
  readonly batchSize?: number;
}

export class PurgeRepo {
  readonly #db: Database;
  readonly #batchSize: number;

  constructor(db: Database, options: PurgeRepoOptions = {}) {
    this.#db = db;
    this.#batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
  }

  /** Projects soft-deleted before `before`, oldest first. */
  async findSoftDeleted(before: Date, limit: number): Promise<readonly string[]> {
    const rows = await this.#db.project.findMany({
      where: { deletedAt: { not: null, lte: before } },
      select: { id: true },
      orderBy: { deletedAt: "asc" },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  /**
   * Deletes one project's derived rows in batches.
   *
   * `onBatch` is called after each statement so the caller can report progress and, in a
   * long purge, notice a SIGTERM between batches rather than mid-transaction.
   */
  async purgeDerivedRows(
    projectId: string,
    onBatch?: (progress: PurgeProgress) => Promise<void> | void,
  ): Promise<readonly PurgeProgress[]> {
    const totals: PurgeProgress[] = [];

    for (const step of steps(projectId)) {
      let deletedForTable = 0;
      for (;;) {
        const { text, values } = step.sql(this.#batchSize);
        const deleted = await this.#db.$executeRawUnsafe(text, ...values);
        deletedForTable += deleted;
        if (deleted > 0 && onBatch !== undefined) {
          await onBatch({ table: step.table, deleted });
        }
        if (deleted < this.#batchSize) break;
      }
      totals.push({ table: step.table, deleted: deletedForTable });
    }

    return totals;
  }

  /**
   * Removes the project row itself. `ai_usage` is a financial ledger: its rows survive with
   * `project_id` nulled by the FK's ON DELETE SET NULL (docs/Database.md §1.6), and
   * `job_runs` history survives the same way.
   */
  async deleteProjectRow(projectId: string): Promise<void> {
    await this.#db.project.deleteMany({ where: { id: projectId, deletedAt: { not: null } } });
  }

  /** Storage keys whose objects the R2 cleanup must remove within the 30-day SLA. */
  async listStorageKeys(projectId: string, limit: number): Promise<readonly string[]> {
    const snapshots = await this.#db.pageSnapshot.findMany({
      where: { crawl: { projectId } },
      select: { storageKey: true },
      take: limit,
    });
    const reports = await this.#db.report.findMany({
      where: { projectId, storageKey: { not: null } },
      select: { storageKey: true },
      take: limit,
    });
    return [
      ...snapshots.map((row) => row.storageKey),
      ...reports.flatMap((row) => (row.storageKey === null ? [] : [row.storageKey])),
    ];
  }
}
