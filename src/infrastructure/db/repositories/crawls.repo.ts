/**
 * Crawl lifecycle and its evidence: crawls, pages, and page snapshots.
 *
 * `crawls` is the snapshot anchor — everything derived hangs off it (docs/Database.md
 * §2.6) — so this repo owns the transitions the rest of the pipeline reads as truth.
 */
import type { Database } from "../prisma.js";
import type { Crawl, CrawlStatus } from "../../../contracts/api/crawls.js";
import type { DocumentSection, ExtractedPage } from "../../../contracts/crawl/extraction.js";
import type { PageSnapshotDetail } from "../../../contracts/api/snapshots.js";
import { newUuidV7 } from "../uuid.js";

export interface StartCrawlInput {
  readonly siteId: string;
  readonly projectId: string;
  readonly trigger: "MANUAL" | "SCHEDULED";
}

export interface CrawlStats {
  readonly pagesDiscovered?: number;
  readonly pagesCrawled?: number;
  readonly pagesChanged?: number;
  readonly pagesFailed?: number;
}

export interface SnapshotInput {
  readonly crawlId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly url: string;
  readonly urlHash: string;
  readonly contentHash: string;
  readonly httpStatus: number;
  readonly extracted: ExtractedPage;
  readonly storageKey: string;
  readonly fetchedAt: Date;
}

export interface SnapshotWriteResult {
  readonly snapshotId: string;
  readonly pageId: string;
  readonly changed: boolean;
  /** The snapshot this one carries forward from, when nothing changed (M7). */
  readonly carriedForwardFromId: string | null;
}

/** A page as the taxonomy and summary prompts see it. */
export interface TopPage {
  readonly url: string;
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly headings: readonly string[];
  readonly wordCount: number | null;
}

/** What the indexing flow needs to decide how a page is handled. */
export interface IndexTarget {
  readonly snapshotId: string;
  readonly pageId: string;
  readonly url: string;
  readonly changed: boolean;
  /** The snapshot whose chunks this one inherits when nothing changed (M7). */
  readonly carriedForwardFromId: string | null;
}

/** A page's text, in the shape the chunker consumes. */
export interface SnapshotContent {
  readonly snapshotId: string;
  readonly url: string;
  readonly sections: readonly DocumentSection[];
  readonly mainText: string;
}

/** A page the quality rubric may be run against. */
export interface QualityCandidate {
  readonly snapshotId: string;
  readonly url: string;
  readonly title: string | null;
  readonly wordCount: number;
  readonly internalLinkCount: number;
  readonly changed: boolean;
  readonly carriedForwardFromId: string | null;
}

/** Everything the rubric prompt is shown about one page. */
export interface QualityInput {
  readonly snapshotId: string;
  readonly url: string;
  readonly title: string | null;
  readonly wordCount: number;
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
  readonly hasStructuredData: boolean;
  readonly headings: readonly string[];
  readonly mainText: string;
}

export interface PageSnapshotSummary {
  readonly id: string;
  readonly pageId: string;
  readonly url: string;
  readonly title: string | null;
  readonly httpStatus: number | null;
  readonly changed: boolean;
  readonly wordCount: number | null;
  readonly qualityScore: number | null;
  readonly fetchedAt: string;
}

/** Prisma row shape → contract shape. Prisma types never leave this folder. */
interface CrawlRow {
  id: string;
  siteId: string;
  status: CrawlStatus;
  trigger: "MANUAL" | "SCHEDULED";
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesChanged: number;
  pagesFailed: number;
  degradation: unknown;
  errorReason: string | null;
  scoringConfigVersion: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function toCrawl(row: CrawlRow): Crawl {
  return {
    id: row.id,
    siteId: row.siteId,
    status: row.status,
    trigger: row.trigger,
    stats: {
      pagesDiscovered: row.pagesDiscovered,
      pagesCrawled: row.pagesCrawled,
      pagesChanged: row.pagesChanged,
      pagesFailed: row.pagesFailed,
    },
    degradation: (row.degradation as Record<string, unknown> | null) ?? null,
    errorReason: row.errorReason,
    scoringConfigVersion: row.scoringConfigVersion,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Statuses the `one_active_crawl_per_site` partial unique index covers. */
export const ACTIVE_CRAWL_STATUSES: readonly CrawlStatus[] = ["QUEUED", "CRAWLING", "ANALYZING"];

export class CrawlsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Creates a QUEUED crawl.
   *
   * A concurrent second attempt violates `one_active_crawl_per_site` and surfaces as a
   * unique error — the database is the backstop, not an application check
   * (docs/Database.md §5).
   */
  async create(input: StartCrawlInput): Promise<Crawl> {
    const row = await this.#db.crawl.create({
      data: {
        id: newUuidV7(),
        siteId: input.siteId,
        projectId: input.projectId,
        trigger: input.trigger,
        status: "QUEUED",
      },
    });
    return toCrawl(row as CrawlRow);
  }

  async findActiveForSite(siteId: string): Promise<Crawl | null> {
    const row = await this.#db.crawl.findFirst({
      where: { siteId, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
    });
    return row === null ? null : toCrawl(row as CrawlRow);
  }

  /**
   * Whether a SCHEDULED crawl was already created for this site since `since` — the
   * scheduler's own "not twice in one week" guard, independent of `findActiveForSite`
   * (which only ever sees a *currently running* crawl, not last week's finished one).
   */
  async hasScheduledSince(siteId: string, since: Date): Promise<boolean> {
    const row = await this.#db.crawl.findFirst({
      where: { siteId, trigger: "SCHEDULED", createdAt: { gte: since } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * On-demand crawls this project has triggered since `since` — the rolling-week quota's
   * input (config/plans.ts's `onDemandCrawlsPerWeek`). Scoped by project, not by site: a
   * quota bypassed by cycling between the own site and a competitor is not a quota.
   */
  async countManualSince(projectId: string, since: Date): Promise<number> {
    return this.#db.crawl.count({
      where: { projectId, trigger: "MANUAL", createdAt: { gte: since } },
    });
  }

  /** Scoped by project so a crawl id from another tenant simply is not found. */
  async findInProject(projectId: string, crawlId: string): Promise<Crawl | null> {
    const row = await this.#db.crawl.findFirst({ where: { id: crawlId, projectId } });
    return row === null ? null : toCrawl(row as CrawlRow);
  }

  /** Index: `crawls(project_id, created_at DESC)`. */
  async listForProject(
    projectId: string,
    limit: number,
    cursor: string | undefined,
    siteId: string | undefined,
  ): Promise<readonly Crawl[]> {
    const rows = await this.#db.crawl.findMany({
      where: { projectId, ...(siteId === undefined ? {} : { siteId }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    return rows.map((row) => toCrawl(row as CrawlRow));
  }

  async markStarted(crawlId: string): Promise<void> {
    await this.#db.crawl.update({
      where: { id: crawlId },
      data: { status: "CRAWLING", startedAt: new Date() },
    });
  }

  async updateStats(crawlId: string, stats: CrawlStats): Promise<void> {
    await this.#db.crawl.update({
      where: { id: crawlId },
      data: {
        ...(stats.pagesDiscovered === undefined ? {} : { pagesDiscovered: stats.pagesDiscovered }),
        ...(stats.pagesCrawled === undefined ? {} : { pagesCrawled: stats.pagesCrawled }),
        ...(stats.pagesChanged === undefined ? {} : { pagesChanged: stats.pagesChanged }),
        ...(stats.pagesFailed === undefined ? {} : { pagesFailed: stats.pagesFailed }),
      },
    });
  }

  async markAnalyzing(crawlId: string): Promise<void> {
    await this.#db.crawl.update({ where: { id: crawlId }, data: { status: "ANALYZING" } });
  }

  async finish(
    crawlId: string,
    status: Extract<
      CrawlStatus,
      "COMPLETED" | "COMPLETED_DEGRADED" | "FAILED" | "CANCELED"
    >,
    options: {
      readonly errorReason?: string | null;
      readonly degradation?: Record<string, unknown> | null;
      readonly pipelineVersion?: string;
    } = {},
  ): Promise<Crawl> {
    const row = await this.#db.crawl.update({
      where: { id: crawlId },
      data: {
        status,
        finishedAt: new Date(),
        ...(options.errorReason === undefined ? {} : { errorReason: options.errorReason }),
        ...(options.degradation === undefined
          ? {}
          : { degradation: options.degradation as never }),
        ...(options.pipelineVersion === undefined
          ? {}
          : { pipelineVersion: options.pipelineVersion }),
      },
    });
    return toCrawl(row as CrawlRow);
  }

  /**
   * Records one crawled page: upserts the canonical `pages` row and inserts the snapshot.
   *
   * Change detection compares against `pages.latest_content_hash` — the single biggest
   * cost lever in the system, since unchanged pages skip embedding and analysis entirely
   * (docs/Backend.md §4.1). Both writes are one transaction: a snapshot whose page row
   * never updated would make the next crawl re-do work it already paid for.
   */
  async recordSnapshot(input: SnapshotInput): Promise<SnapshotWriteResult> {
    return this.#db.$transaction(async (tx) => {
      const existing = await tx.page.findUnique({
        where: { siteId_urlHash: { siteId: input.siteId, urlHash: input.urlHash } },
        select: { id: true, latestContentHash: true },
      });

      const pageId = existing?.id ?? newUuidV7();
      const changed = existing === null || existing.latestContentHash !== input.contentHash;

      if (existing === null) {
        await tx.page.create({
          data: {
            id: pageId,
            siteId: input.siteId,
            url: input.url,
            urlHash: input.urlHash,
            latestContentHash: input.contentHash,
            firstSeenAt: input.fetchedAt,
            lastSeenAt: input.fetchedAt,
          },
        });
      } else {
        await tx.page.update({
          where: { id: pageId },
          data: {
            url: input.url,
            lastSeenAt: input.fetchedAt,
            ...(changed ? { latestContentHash: input.contentHash } : {}),
          },
        });
      }

      // Unchanged pages point at the snapshot whose analysis they inherit.
      const carriedForwardFromId = changed
        ? null
        : ((
            await tx.pageSnapshot.findFirst({
              where: { pageId, contentHash: input.contentHash },
              orderBy: { createdAt: "desc" },
              select: { id: true },
            })
          )?.id ?? null);

      const snapshot = await tx.pageSnapshot.upsert({
        where: { crawlId_pageId: { crawlId: input.crawlId, pageId } },
        update: {},
        create: {
          id: newUuidV7(),
          crawlId: input.crawlId,
          pageId,
          httpStatus: input.httpStatus,
          contentHash: input.contentHash,
          changed,
          carriedForwardFromId,
          title: input.extracted.title,
          wordCount: input.extracted.wordCount,
          publishedAt:
            input.extracted.publishedAt === null ? null : new Date(input.extracted.publishedAt),
          pageUpdatedAt:
            input.extracted.updatedAt === null ? null : new Date(input.extracted.updatedAt),
          hasStructuredData: input.extracted.hasStructuredData,
          internalLinkCount: input.extracted.internalLinkCount,
          externalLinkCount: input.extracted.externalLinkCount,
          extracted: input.extracted as never,
          storageKey: input.storageKey,
          fetchedAt: input.fetchedAt,
        },
        select: { id: true },
      });

      return { snapshotId: snapshot.id, pageId, changed, carriedForwardFromId };
    });
  }

  /** Index: `page_snapshots(crawl_id, page_id)` unique; paginated by snapshot id. */
  async listSnapshots(
    crawlId: string,
    limit: number,
    cursor: string | undefined,
    changedOnly: boolean | undefined,
  ): Promise<readonly PageSnapshotSummary[]> {
    const rows = await this.#db.pageSnapshot.findMany({
      where: { crawlId, ...(changedOnly === undefined ? {} : { changed: changedOnly }) },
      orderBy: { id: "asc" },
      take: limit,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      select: {
        id: true,
        pageId: true,
        title: true,
        httpStatus: true,
        changed: true,
        wordCount: true,
        qualityScore: true,
        fetchedAt: true,
        page: { select: { url: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      pageId: row.pageId,
      url: row.page.url,
      title: row.title,
      httpStatus: row.httpStatus,
      changed: row.changed,
      wordCount: row.wordCount,
      qualityScore: row.qualityScore,
      fetchedAt: row.fetchedAt.toISOString(),
    }));
  }

  /**
   * Merges one stage's block into the crawl's analysis artifact (docs/adr/0003).
   *
   * Merge, never overwrite: the artifact is assembled by several pipeline stages, and a
   * stage that degrades must leave the others' work intact — that is what makes the
   * partial-answer guarantee real (AI-Pipeline §9).
   */
  async mergeAnalysis(crawlId: string, block: Record<string, unknown>): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      const current = await tx.crawl.findUnique({
        where: { id: crawlId },
        select: { analysis: true },
      });
      const existing = (current?.analysis as Record<string, unknown> | null) ?? {};
      await tx.crawl.update({
        where: { id: crawlId },
        data: { analysis: { ...existing, ...block } as never },
      });
    });
  }

  /** The assembled artifact the analysis endpoint serves. */
  async findAnalysis(
    projectId: string,
    crawlId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.#db.crawl.findFirst({
      where: { id: crawlId, projectId },
      select: { analysis: true },
    });
    if (row === null) return null;
    return (row.analysis as Record<string, unknown> | null) ?? {};
  }

  /**
   * The most recent completed crawl for a site, excluding one in progress — the baseline a
   * change comparison reads.
   */
  async findPreviousCompleted(siteId: string, excludingCrawlId: string): Promise<string | null> {
    const row = await this.#db.crawl.findFirst({
      where: {
        siteId,
        id: { not: excludingCrawlId },
        status: { in: ["COMPLETED", "COMPLETED_DEGRADED"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Snapshot detail — the evidence view behind every recommendation and analysis claim
   * (docs/API.md §3). Scoped through the crawl to the project, so a snapshot id from
   * another tenant simply is not found.
   */
  async findSnapshotInProject(
    projectId: string,
    snapshotId: string,
  ): Promise<PageSnapshotDetail | null> {
    const row = await this.#db.pageSnapshot.findFirst({
      where: { id: snapshotId, crawl: { projectId } },
      select: {
        id: true,
        pageId: true,
        title: true,
        httpStatus: true,
        changed: true,
        wordCount: true,
        qualityScore: true,
        fetchedAt: true,
        hasStructuredData: true,
        internalLinkCount: true,
        externalLinkCount: true,
        extracted: true,
        quality: true,
        carriedForwardFromId: true,
        page: { select: { url: true } },
      },
    });
    if (row === null) return null;

    return {
      id: row.id,
      pageId: row.pageId,
      url: row.page.url,
      title: row.title,
      httpStatus: row.httpStatus,
      changed: row.changed,
      wordCount: row.wordCount,
      qualityScore: row.qualityScore,
      fetchedAt: row.fetchedAt.toISOString(),
      hasStructuredData: row.hasStructuredData,
      internalLinkCount: row.internalLinkCount,
      externalLinkCount: row.externalLinkCount,
      extracted: (row.extracted as Record<string, unknown> | null) ?? {},
      quality: (row.quality as Record<string, unknown> | null) ?? null,
      carriedForwardFromId: row.carriedForwardFromId,
    };
  }

  /**
   * The crawl's highest-authority pages: homepage first, then by internal in-degree.
   *
   * That ordering is the site's own signal about what matters, and it is what the taxonomy
   * prompt is given rather than a random sample.
   *
   * Index: `page_snapshots(crawl_id, page_id)`.
   */
  async listTopPagesForCrawl(crawlId: string, limit: number): Promise<readonly TopPage[]> {
    const rows = await this.#db.pageSnapshot.findMany({
      where: { crawlId },
      orderBy: [{ internalLinkCount: "desc" }, { wordCount: "desc" }],
      take: limit,
      select: {
        title: true,
        extracted: true,
        wordCount: true,
        page: { select: { url: true } },
      },
    });

    const mapped = rows.map((row) => {
      const extracted = (row.extracted as Record<string, unknown> | null) ?? {};
      const headings = Array.isArray(extracted["headings"])
        ? (extracted["headings"] as Array<{ text?: unknown }>).flatMap((heading) =>
            typeof heading.text === "string" ? [heading.text] : [],
          )
        : [];
      return {
        url: row.page.url,
        title: row.title,
        metaDescription:
          typeof extracted["metaDescription"] === "string"
            ? (extracted["metaDescription"] as string)
            : null,
        headings,
        wordCount: row.wordCount,
      };
    });

    // The homepage leads regardless of link count: it is the site's own summary of itself.
    const homepageIndex = mapped.findIndex((page) => new URL(page.url).pathname === "/");
    if (homepageIndex > 0) {
      const [homepage] = mapped.splice(homepageIndex, 1);
      if (homepage !== undefined) mapped.unshift(homepage);
    }
    return mapped;
  }

  /**
   * The most recent completed crawl for a site — what every "latest" read resolves to.
   *
   * Index: `crawls(site_id, created_at DESC)`.
   */
  async findLatestCompleted(siteId: string): Promise<string | null> {
    const row = await this.#db.crawl.findFirst({
      where: { siteId, status: { in: ["COMPLETED", "COMPLETED_DEGRADED"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Finished crawls whose `ai_cost_usd_micros` rollup was never written — the usage-rollup
   * job's backlog. Bounded so one tick's batch is predictable regardless of history size.
   */
  async listMissingCostRollup(limit: number): Promise<readonly string[]> {
    const rows = await this.#db.crawl.findMany({
      where: {
        status: { in: ["COMPLETED", "COMPLETED_DEGRADED"] },
        aiCostUsdMicros: 0n,
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async setCostRollup(crawlId: string, costUsdMicros: bigint): Promise<void> {
    await this.#db.crawl.update({ where: { id: crawlId }, data: { aiCostUsdMicros: costUsdMicros } });
  }

  /**
   * Every page this crawl captured, tagged with whether it changed.
   *
   * Deliberately no content: the flow builder only needs to divide the work into batches,
   * and loading a hundred pages of extracted text to do that would be absurd.
   *
   * Index: `page_snapshots(crawl_id, page_id)` unique.
   */
  async listIndexTargets(crawlId: string): Promise<readonly IndexTarget[]> {
    const rows = await this.#db.pageSnapshot.findMany({
      where: { crawlId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        pageId: true,
        changed: true,
        carriedForwardFromId: true,
        page: { select: { url: true } },
      },
    });
    return rows.map((row) => ({
      snapshotId: row.id,
      pageId: row.pageId,
      url: row.page.url,
      changed: row.changed,
      carriedForwardFromId: row.carriedForwardFromId,
    }));
  }

  /**
   * The extracted text for a batch of snapshots.
   *
   * `sections` is defaulted for snapshots written before M10 added it: those pages chunk
   * from `mainText` as one unheaded section, which is the same treatment a page with no
   * headings gets.
   */
  async loadSnapshotContent(
    snapshotIds: readonly string[],
  ): Promise<readonly SnapshotContent[]> {
    if (snapshotIds.length === 0) return [];
    const rows = await this.#db.pageSnapshot.findMany({
      where: { id: { in: [...snapshotIds] } },
      select: { id: true, extracted: true, page: { select: { url: true } } },
    });

    return rows.map((row) => {
      const extracted = (row.extracted as Record<string, unknown> | null) ?? {};
      const rawSections = extracted["sections"];
      const sections: DocumentSection[] = Array.isArray(rawSections)
        ? rawSections.flatMap((section) => {
            const candidate = section as { headingPath?: unknown; text?: unknown };
            if (typeof candidate.text !== "string") return [];
            return [
              {
                headingPath:
                  typeof candidate.headingPath === "string" ? candidate.headingPath : null,
                text: candidate.text,
              },
            ];
          })
        : [];

      return {
        snapshotId: row.id,
        url: row.page.url,
        sections,
        mainText: typeof extracted["mainText"] === "string" ? extracted["mainText"] : "",
      };
    });
  }

  /**
   * Pages eligible for quality scoring, homepage first then by internal in-degree.
   *
   * Ordering is the sampling policy's input, not a nicety: AI-Pipeline §3.2 samples the
   * homepage plus the most-linked pages, because a rubric run over a random thirty pages
   * measures the long tail rather than the site.
   */
  async listQualityCandidates(crawlId: string): Promise<readonly QualityCandidate[]> {
    const rows = await this.#db.pageSnapshot.findMany({
      where: { crawlId, OR: [{ httpStatus: null }, { httpStatus: { gte: 200, lt: 300 } }] },
      orderBy: [{ internalLinkCount: "desc" }, { wordCount: "desc" }, { id: "asc" }],
      select: {
        id: true,
        title: true,
        wordCount: true,
        internalLinkCount: true,
        changed: true,
        carriedForwardFromId: true,
        page: { select: { url: true } },
      },
    });

    return rows.map((row) => ({
      snapshotId: row.id,
      url: row.page.url,
      title: row.title,
      wordCount: row.wordCount ?? 0,
      internalLinkCount: row.internalLinkCount ?? 0,
      changed: row.changed,
      carriedForwardFromId: row.carriedForwardFromId,
    }));
  }

  /** The rubric's input for a batch of snapshots. */
  async loadQualityInputs(snapshotIds: readonly string[]): Promise<readonly QualityInput[]> {
    if (snapshotIds.length === 0) return [];
    const rows = await this.#db.pageSnapshot.findMany({
      where: { id: { in: [...snapshotIds] } },
      select: {
        id: true,
        title: true,
        wordCount: true,
        publishedAt: true,
        pageUpdatedAt: true,
        hasStructuredData: true,
        extracted: true,
        page: { select: { url: true } },
      },
    });

    return rows.map((row) => {
      const extracted = (row.extracted as Record<string, unknown> | null) ?? {};
      const headings = Array.isArray(extracted["headings"])
        ? (extracted["headings"] as Array<{ path?: unknown; text?: unknown }>).flatMap(
            (heading) => {
              const label = heading.path ?? heading.text;
              return typeof label === "string" ? [label] : [];
            },
          )
        : [];
      return {
        snapshotId: row.id,
        url: row.page.url,
        title: row.title,
        wordCount: row.wordCount ?? 0,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.pageUpdatedAt?.toISOString() ?? null,
        hasStructuredData: row.hasStructuredData,
        headings,
        mainText: typeof extracted["mainText"] === "string" ? extracted["mainText"] : "",
      };
    });
  }

  /** Records one page's rubric result. */
  async setQuality(
    snapshotId: string,
    score: number,
    rubric: Record<string, unknown>,
  ): Promise<void> {
    await this.#db.pageSnapshot.update({
      where: { id: snapshotId },
      data: { qualityScore: score, quality: rubric as never },
    });
  }

  /**
   * Copies an unchanged page's rubric forward (AI-Pipeline §3.2).
   *
   * Same argument as carrying chunks forward: the content is byte-identical, so paying a
   * model to re-score it would buy nothing but drift — and drift is precisely what the
   * ±3-point stability requirement forbids.
   */
  async carryForwardQuality(snapshotId: string, sourceSnapshotId: string): Promise<boolean> {
    const source = await this.#db.pageSnapshot.findUnique({
      where: { id: sourceSnapshotId },
      select: { qualityScore: true, quality: true },
    });
    if (source === null || source.qualityScore === null) return false;

    await this.#db.pageSnapshot.update({
      where: { id: snapshotId },
      data: { qualityScore: source.qualityScore, quality: source.quality as never },
    });
    return true;
  }

  /** Every page score this crawl produced — the content-quality component's input. */
  async qualityScores(crawlId: string): Promise<readonly number[]> {
    const rows = await this.#db.pageSnapshot.findMany({
      where: { crawlId, qualityScore: { not: null } },
      select: { qualityScore: true },
    });
    return rows.flatMap((row) => (row.qualityScore === null ? [] : [row.qualityScore]));
  }

  /** URLs already captured by this crawl — the durable half of the resume checkpoint. */
  async fetchedUrls(crawlId: string): Promise<readonly string[]> {
    const rows = await this.#db.pageSnapshot.findMany({
      where: { crawlId },
      select: { page: { select: { url: true } } },
    });
    return rows.map((row) => row.page.url);
  }
}
