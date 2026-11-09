/**
 * The `reports` table (docs/Database.md §2.17).
 *
 * A report is a pointer to immutable inputs plus a rendered artifact — `crawlId` and
 * `promptRunId` are pinned at creation, not re-resolved at render time, so a retried job
 * always reproduces the same PDF rather than drifting onto whatever became "latest" while
 * it sat in the queue.
 */
import type { Database } from "../prisma.js";
import type { Report, ReportSection } from "../../../contracts/api/reports.js";
import { newUuidV7 } from "../uuid.js";

export interface NewReport {
  readonly projectId: string;
  readonly kind: "ON_DEMAND" | "SCHEDULED";
  readonly crawlId: string | null;
  readonly promptRunId: string | null;
  readonly sections: readonly ReportSection[];
}

interface ReportRow {
  id: string;
  kind: "ON_DEMAND" | "SCHEDULED";
  status: "QUEUED" | "GENERATING" | "READY" | "FAILED";
  crawlId: string | null;
  promptRunId: string | null;
  sizeBytes: number | null;
  generatedAt: Date | null;
  createdAt: Date;
}

function toReport(row: ReportRow): Report {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    crawlId: row.crawlId,
    promptRunId: row.promptRunId,
    sizeBytes: row.sizeBytes,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const select = {
  id: true,
  kind: true,
  status: true,
  crawlId: true,
  promptRunId: true,
  sizeBytes: true,
  generatedAt: true,
  createdAt: true,
} as const;

export class ReportsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async create(input: NewReport): Promise<Report> {
    const row = await this.#db.report.create({
      data: {
        id: newUuidV7(),
        projectId: input.projectId,
        kind: input.kind,
        status: "QUEUED",
        crawlId: input.crawlId,
        promptRunId: input.promptRunId,
        params: { sections: [...input.sections] },
      },
      select,
    });
    return toReport(row as ReportRow);
  }

  async findInProject(projectId: string, reportId: string): Promise<Report | null> {
    const row = await this.#db.report.findFirst({ where: { id: reportId, projectId }, select });
    return row === null ? null : toReport(row as ReportRow);
  }

  /** What the report was asked to include — read back by the processor, not the client. */
  async sectionsFor(reportId: string): Promise<readonly ReportSection[]> {
    const row = await this.#db.report.findUnique({
      where: { id: reportId },
      select: { params: true },
    });
    const params = row?.params as { sections?: unknown } | null;
    return Array.isArray(params?.sections) ? (params.sections as ReportSection[]) : [];
  }

  /** Index: `reports(project_id, created_at DESC)`. */
  async listForProject(
    projectId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<readonly Report[]> {
    const rows = await this.#db.report.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      select,
    });
    return rows.map((row) => toReport(row as ReportRow));
  }

  async markGenerating(reportId: string): Promise<void> {
    await this.#db.report.update({ where: { id: reportId }, data: { status: "GENERATING" } });
  }

  async markReady(
    reportId: string,
    result: { readonly storageKey: string; readonly sizeBytes: number; readonly generatedAt: Date },
  ): Promise<void> {
    await this.#db.report.update({
      where: { id: reportId },
      data: {
        status: "READY",
        storageKey: result.storageKey,
        sizeBytes: result.sizeBytes,
        generatedAt: result.generatedAt,
      },
    });
  }

  async markFailed(reportId: string): Promise<void> {
    await this.#db.report.update({ where: { id: reportId }, data: { status: "FAILED" } });
  }

  /**
   * Storage key for the download redirect — deliberately not on the public `Report` shape,
   * since an R2 object key is an implementation detail, not part of the API contract.
   */
  async downloadInfo(
    projectId: string,
    reportId: string,
  ): Promise<{ readonly status: Report["status"]; readonly storageKey: string | null } | null> {
    const row = await this.#db.report.findFirst({
      where: { id: reportId, projectId },
      select: { status: true, storageKey: true },
    });
    return row === null ? null : { status: row.status, storageKey: row.storageKey };
  }
}
