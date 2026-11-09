/**
 * Site reads/writes. A competitor is not a second-class object — it is a `sites` row with
 * `role = COMPETITOR`, crawled by the identical pipeline (docs/Database.md §2.5).
 */
import type { Database } from "../prisma.js";
import type { Site } from "../../../contracts/api/projects.js";
import { newUuidV7 } from "../uuid.js";

export interface NewCompetitor {
  readonly projectId: string;
  readonly url: string;
  readonly domain: string;
  readonly name: string | null;
}

interface SiteRow {
  id: string;
  url: string;
  domain: string;
  role: "OWN" | "COMPETITOR";
  name: string | null;
}

const siteSelect = { id: true, url: true, domain: true, role: true, name: true } as const;

function toSite(row: SiteRow): Site {
  return { id: row.id, url: row.url, domain: row.domain, role: row.role, name: row.name };
}

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

export class SitesRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Index: `sites(project_id)`. */
  async listForProject(projectId: string, role?: "OWN" | "COMPETITOR"): Promise<readonly Site[]> {
    const rows = await this.#db.site.findMany({
      where: { projectId, ...(role === undefined ? {} : { role }) },
      select: siteSelect,
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => toSite(row as SiteRow));
  }

  async findOwnSite(projectId: string): Promise<Site | null> {
    const row = await this.#db.site.findFirst({
      where: { projectId, role: "OWN" },
      select: siteSelect,
    });
    return row === null ? null : toSite(row as SiteRow);
  }

  async findInProject(projectId: string, siteId: string): Promise<Site | null> {
    const row = await this.#db.site.findFirst({
      where: { id: siteId, projectId },
      select: siteSelect,
    });
    return row === null ? null : toSite(row as SiteRow);
  }

  async countCompetitors(projectId: string): Promise<number> {
    return this.#db.site.count({ where: { projectId, role: "COMPETITOR" } });
  }

  /** Throws a unique violation when the URL is already tracked for this project. */
  async addCompetitor(input: NewCompetitor): Promise<Site> {
    const row = await this.#db.site.create({
      data: {
        id: newUuidV7(),
        projectId: input.projectId,
        url: input.url,
        domain: input.domain,
        role: "COMPETITOR",
        name: input.name,
      },
      select: siteSelect,
    });
    return toSite(row as SiteRow);
  }

  /**
   * Removes a competitor. Its crawl history cascades with the row; the API documents this
   * as "retained but detached from comparisons" — retention of the *evidence* belongs to
   * the snapshots in R2, which the purge job governs separately.
   */
  async removeCompetitor(projectId: string, siteId: string): Promise<void> {
    await this.#db.site.deleteMany({ where: { id: siteId, projectId, role: "COMPETITOR" } });
  }
}
