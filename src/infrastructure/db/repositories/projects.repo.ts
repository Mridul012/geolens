/**
 * Project and ownership reads/writes.
 *
 * Repositories accept and return contract shapes; Prisma types never cross out of this
 * folder (golden rule #3). Every method is project- or user-scoped — there is no
 * "find by id" that forgets whose id it is.
 */
import type { Database } from "../prisma.js";
import type { Project, ProjectDetail, Site } from "../../../contracts/api/projects.js";
import type { Crawl } from "../../../contracts/api/crawls.js";
import type { Score } from "../../../contracts/api/scores.js";
import { newUuidV7 } from "../uuid.js";

export interface NewSite {
  readonly url: string;
  readonly domain: string;
  readonly role: "OWN" | "COMPETITOR";
  readonly name: string | null;
}

export interface NewProject {
  readonly userId: string;
  readonly name: string;
  readonly timezone: string;
  readonly sites: readonly NewSite[];
}

export interface ProjectUpdate {
  readonly name?: string | undefined;
  readonly timezone?: string | undefined;
  readonly status?: "ACTIVE" | "ARCHIVED" | undefined;
}

interface SiteRow {
  id: string;
  url: string;
  domain: string;
  role: "OWN" | "COMPETITOR";
  name: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  timezone: string;
  createdAt: Date;
  sites: SiteRow[];
}

const siteSelect = { id: true, url: true, domain: true, role: true, name: true } as const;

const projectSelect = {
  id: true,
  name: true,
  status: true,
  timezone: true,
  createdAt: true,
  sites: { select: siteSelect, orderBy: { role: "asc" } },
} as const;

function toSite(row: SiteRow): Site {
  return { id: row.id, url: row.url, domain: row.domain, role: row.role, name: row.name };
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
    sites: row.sites.map(toSite),
  };
}

export class ProjectsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * The ownership resolution behind `assertProjectAccess`. Returns null both when the
   * project does not exist and when it belongs to somebody else — the caller turns either
   * into a 404, so the two are indistinguishable from outside (docs/API.md §4.2).
   *
   * Index: `projects(user_id)`.
   */
  async findOwned(projectId: string, userId: string): Promise<Project | null> {
    const row = await this.#db.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: projectSelect,
    });
    return row === null ? null : toProject(row as ProjectRow);
  }

  /**
   * Unscoped lookup for worker processors, which arrive with a job payload rather than a
   * session. It returns the owner so the worker can resolve entitlements itself — never a
   * substitute for {@link findOwned} on a user-facing path.
   */
  async findAnyById(projectId: string): Promise<(Project & { userId: string }) | null> {
    const row = await this.#db.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { ...projectSelect, userId: true },
    });
    return row === null
      ? null
      : { ...toProject(row as ProjectRow), userId: (row as { userId: string }).userId };
  }

  /** Cursor-paginated list, newest first (docs/API.md §1 — no offsets, no totals). */
  async listOwned(
    userId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<readonly Project[]> {
    const rows = await this.#db.project.findMany({
      where: { userId, deletedAt: null },
      select: projectSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    return rows.map((row) => toProject(row as ProjectRow));
  }

  async countOwned(userId: string): Promise<number> {
    return this.#db.project.count({ where: { userId, deletedAt: null } });
  }

  /**
   * Creates the project and its sites atomically — a project without its OWN site is not a
   * state the rest of the system knows how to handle (Engineering-Rules §5: transactions
   * wrap every multi-step write that must be atomic).
   */
  async create(input: NewProject): Promise<Project> {
    const projectId = newUuidV7();
    const row = await this.#db.$transaction(async (tx) => {
      await tx.project.create({
        data: {
          id: projectId,
          userId: input.userId,
          name: input.name,
          timezone: input.timezone,
        },
      });
      await tx.site.createMany({
        data: input.sites.map((site) => ({
          id: newUuidV7(),
          projectId,
          url: site.url,
          domain: site.domain,
          role: site.role,
          name: site.name,
        })),
      });
      return tx.project.findUniqueOrThrow({ where: { id: projectId }, select: projectSelect });
    });
    return toProject(row as ProjectRow);
  }

  async update(projectId: string, patch: ProjectUpdate): Promise<Project> {
    const row = await this.#db.project.update({
      where: { id: projectId },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
      select: projectSelect,
    });
    return toProject(row as ProjectRow);
  }

  /**
   * Soft-delete. A hard cascade over a project with tens of thousands of snapshot rows
   * would lock tables at exactly the moment a user is watching (docs/Database.md §1.6);
   * the purge job drains children in batches afterwards.
   */
  async softDelete(projectId: string, deletedAt: Date): Promise<void> {
    await this.#db.project.update({ where: { id: projectId }, data: { deletedAt } });
  }

  /**
   * Detail view: the project plus its most recent crawl and score.
   *
   * Indexes: `crawls(project_id, created_at DESC)`, `scores(project_id, created_at DESC)`.
   */
  async findDetail(projectId: string, userId: string): Promise<ProjectDetail | null> {
    const project = await this.findOwned(projectId, userId);
    if (project === null) return null;

    const [crawl, score] = await Promise.all([
      this.#db.crawl.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" },
      }),
      this.#db.score.findFirst({
        where: { projectId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const latestCrawl: Crawl | null =
      crawl === null
        ? null
        : {
            id: crawl.id,
            siteId: crawl.siteId,
            status: crawl.status,
            trigger: crawl.trigger,
            stats: {
              pagesDiscovered: crawl.pagesDiscovered,
              pagesCrawled: crawl.pagesCrawled,
              pagesChanged: crawl.pagesChanged,
              pagesFailed: crawl.pagesFailed,
            },
            degradation: (crawl.degradation as Record<string, unknown> | null) ?? null,
            errorReason: crawl.errorReason,
            scoringConfigVersion: crawl.scoringConfigVersion,
            queuedAt: crawl.queuedAt.toISOString(),
            startedAt: crawl.startedAt?.toISOString() ?? null,
            finishedAt: crawl.finishedAt?.toISOString() ?? null,
          };

    const latestScore: Score | null =
      score === null
        ? null
        : {
            id: score.id,
            composite: score.composite,
            scoreCitation: score.scoreCitation,
            scoreRetrievability: score.scoreRetrievability,
            scoreContentQuality: score.scoreContentQuality,
            scoreTopicCoverage: score.scoreTopicCoverage,
            scoreTechnical: score.scoreTechnical,
            scoreTrust: score.scoreTrust,
            crawlId: score.crawlId,
            promptRunId: score.promptRunId,
            scoringConfigVersion: score.scoringConfigVersion,
            createdAt: score.createdAt.toISOString(),
          };

    return { ...project, latestCrawl, latestScore };
  }

  /** One project, staggered scheduling needs to reach: the owner and the own site. */
  async listScheduledEligible(): Promise<
    ReadonlyArray<{
      readonly projectId: string;
      readonly userId: string;
      readonly timezone: string;
      readonly ownSiteId: string;
    }>
  > {
    const rows = await this.#db.project.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        // Scheduled automation is a paid unlock (PRD FR-3.7, FR-7.2) — an active or
        // trialing subscription, not merely "one exists" (a canceled row loses it).
        user: { subscription: { plan: "PRO", status: { in: ["ACTIVE", "TRIALING"] } } },
        sites: { some: { role: "OWN" } },
      },
      select: {
        id: true,
        userId: true,
        timezone: true,
        sites: { where: { role: "OWN" }, select: { id: true }, take: 1 },
      },
    });
    return rows.flatMap((row) => {
      const ownSite = row.sites[0];
      return ownSite === undefined
        ? []
        : [{ projectId: row.id, userId: row.userId, timezone: row.timezone, ownSiteId: ownSite.id }];
    });
  }

  /** Every non-deleted project — the budget monitor's sweep (spend is not a paid-only risk). */
  async listActive(): Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>> {
    return this.#db.project.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
    });
  }
}
