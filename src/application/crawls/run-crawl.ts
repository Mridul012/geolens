/**
 * The crawl pipeline (docs/Backend.md §4.1, docs/Architecture.md Stage 1).
 *
 * One job = one site. For each page: extract, gzip the raw HTML to object storage as
 * evidence, and write `pages` + `page_snapshots` with change detection. Progress streams
 * to Redis throughout so the SSE endpoint has something honest to narrate.
 *
 * Degradation over failure: a page that fails is counted and the crawl continues; a crawl
 * that is cancelled or drained keeps everything it captured. A crawl never ends in a blank
 * state (docs/Backend.md §16).
 */
import { gzipSync } from "node:zlib";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import { contentHashOf } from "../../domain/crawl/content-hash.js";
import { normalizePageUrl, urlHash } from "../../domain/crawl/url.js";
import { snapshotKey } from "../../domain/crawl/storage-keys.js";
import { limitsFor } from "../../config/plans.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import type { EventsRepo } from "../../infrastructure/db/repositories/events.repo.js";
import type { CrawlerEngine } from "../ports/crawler-engine.port.js";
import type { ObjectStorage } from "../ports/object-storage.port.js";
import type { ProgressStore } from "../ports/progress-store.port.js";
import type { PageExtractor } from "../ports/page-extractor.port.js";
import type { JobLogger } from "../ports/job-context.port.js";

export interface RunCrawlDeps {
  readonly crawls: CrawlsRepo;
  readonly sites: SitesRepo;
  readonly projects: ProjectsRepo;
  readonly users: UsersRepo;
  readonly events: EventsRepo;
  readonly engine: CrawlerEngine;
  readonly storage: ObjectStorage;
  readonly progress: ProgressStore;
  readonly extract: PageExtractor;
  readonly log: JobLogger;
  /** True once the worker is draining; the crawl checkpoints rather than dies. */
  readonly shouldStop?: (() => boolean) | undefined;
}

export interface RunCrawlInput {
  readonly crawlId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly ownerUserId?: string | undefined;
}

export interface RunCrawlResult {
  readonly crawlId: string;
  readonly pagesCrawled: number;
  readonly pagesChanged: number;
  readonly pagesFailed: number;
  readonly stoppedEarly: boolean;
  readonly canceled: boolean;
}

/** Progress is written at most this often, so a fast crawl does not hammer Redis. */
const PROGRESS_EVERY_PAGES = 1;

function stageMessage(pagesCrawled: number, pagesFound: number): string {
  if (pagesCrawled === 0) return "Looking for pages to read…";
  return `Reading your site — ${pagesCrawled} of ${pagesFound} pages so far`;
}

export async function runCrawl(
  deps: RunCrawlDeps,
  input: RunCrawlInput,
): Promise<Result<RunCrawlResult, AppError>> {
  // Workers re-verify entity state from the database and never trust the job payload for
  // authorization (Engineering-Rules §12).
  const crawl = await deps.crawls.findInProject(input.projectId, input.crawlId);
  if (crawl === null) return err(notFound("Crawl"));

  const site = await deps.sites.findInProject(input.projectId, input.siteId);
  if (site === null) return err(notFound("Site"));

  const project = await deps.projects.findAnyById(input.projectId);
  if (project === null) return err(notFound("Project"));

  const plan = await deps.users.findPlan(project.userId);
  const maxPages = limitsFor(plan).pagesPerCrawl;

  await deps.crawls.markStarted(input.crawlId);
  await deps.progress.setCrawlProgress(input.crawlId, {
    stage: "discovering",
    message: "Finding your pages…",
    pagesFound: 0,
    pagesCrawled: 0,
  });

  // Resume has two halves. The durable one is Postgres: pages already captured are never
  // fetched twice. The operational one is the saved frontier, which carries the
  // link-derived URLs discovery alone cannot recover — losing it degrades resume, it never
  // breaks it.
  const alreadyFetched = await deps.crawls.fetchedUrls(input.crawlId);
  const checkpoint = await deps.progress.loadFrontier(input.crawlId);

  if (alreadyFetched.length > 0) {
    deps.log.info(
      {
        crawlId: input.crawlId,
        alreadyFetched: alreadyFetched.length,
        frontier: checkpoint?.urls.length ?? 0,
      },
      "resuming crawl from checkpoint",
    );
  }

  let pagesCrawled = alreadyFetched.length;
  let pagesChanged = 0;
  let pagesFailed = 0;
  let pagesFound = Math.max(alreadyFetched.length, 1);
  let canceled = false;

  const stopRequested = async (): Promise<boolean> => {
    if (deps.shouldStop?.() === true) return true;
    if (await deps.progress.isCancelRequested(input.crawlId)) {
      canceled = true;
      return true;
    }
    return false;
  };

  const result = await deps.engine.crawlSite({
    startUrl: site.url,
    siteHost: site.domain,
    maxPages,
    alreadyFetched,
    ...(checkpoint === null ? {} : { resumeFrontier: checkpoint.urls }),
    shouldStop: stopRequested,
    onFrontier: async (remaining) => {
      await deps.progress.saveFrontier(input.crawlId, remaining);
    },
    onDiscovered: async (count) => {
      pagesFound = Math.max(pagesFound, Math.min(count, maxPages));
      await deps.progress.setCrawlProgress(input.crawlId, {
        stage: "crawling",
        message: stageMessage(pagesCrawled, pagesFound),
        pagesFound,
      });
    },
    onFailure: async (failure) => {
      pagesFailed += 1;
      deps.log.warn({ url: failure.url, reason: failure.reason }, "page failed");
      await deps.crawls.updateStats(input.crawlId, { pagesFailed });
    },
    onPage: async (page) => {
      const normalized = normalizePageUrl(page.url);
      if (!normalized.ok) return;

      const extracted = deps.extract(page.html, {
        pageUrl: normalized.value.href,
        siteHost: site.domain,
      });

      // The hash is over extracted content, not raw HTML: a changed build id or rotating
      // CSRF token in the markup must not look like a content change, or change detection
      // — the biggest cost lever in the system — stops saving anything.
      const contentHash = contentHashOf(extracted);
      const key = snapshotKey(input.projectId, input.crawlId, contentHash);

      // Snapshots are gzipped: they are bulky, write-once, and read back rarely
      // (docs/Backend.md §9).
      await deps.storage.put({
        key,
        body: gzipSync(Buffer.from(page.html, "utf8")),
        contentType: "text/html; charset=utf-8",
        contentEncoding: "gzip",
      });

      const written = await deps.crawls.recordSnapshot({
        crawlId: input.crawlId,
        projectId: input.projectId,
        siteId: site.id,
        url: normalized.value.href,
        urlHash: urlHash(normalized.value.href),
        contentHash,
        httpStatus: page.status,
        extracted,
        storageKey: key,
        fetchedAt: page.fetchedAt,
      });

      pagesCrawled += 1;
      if (written.changed) pagesChanged += 1;
      pagesFound = Math.max(pagesFound, pagesCrawled);

      if (pagesCrawled % PROGRESS_EVERY_PAGES === 0) {
        await deps.progress.setCrawlProgress(input.crawlId, {
          stage: "crawling",
          message: stageMessage(pagesCrawled, pagesFound),
          pagesCrawled,
          pagesFound,
          currentUrl: normalized.value.href,
        });
        await deps.crawls.updateStats(input.crawlId, { pagesCrawled, pagesChanged });
      }
    },
  });

  await deps.crawls.updateStats(input.crawlId, {
    pagesDiscovered: Math.max(result.pagesDiscovered, pagesCrawled),
    pagesCrawled,
    pagesChanged,
    pagesFailed,
  });

  if (canceled) {
    // A canceled crawl is terminal: no retry will resume it, so the checkpoint is noise.
    await deps.progress.clearFrontier(input.crawlId);
    await deps.crawls.finish(input.crawlId, "CANCELED", {
      errorReason: "Canceled by the user.",
    });
    await deps.progress.setCrawlProgress(input.crawlId, {
      stage: "canceled",
      message: "Crawl canceled. Everything captured so far has been kept.",
      status: "CANCELED",
    });
    return ok({
      crawlId: input.crawlId,
      pagesCrawled,
      pagesChanged,
      pagesFailed,
      stoppedEarly: true,
      canceled: true,
    });
  }

  // A drained worker leaves the crawl mid-flight on purpose: the retried job resumes from
  // the snapshots already written rather than restarting (Engineering-Rules §7).
  if (deps.shouldStop?.() === true) {
    deps.log.info(
      { crawlId: input.crawlId, pagesCrawled, remaining: result.remainingFrontier.length },
      "crawl checkpointed for shutdown",
    );
    return ok({
      crawlId: input.crawlId,
      pagesCrawled,
      pagesChanged,
      pagesFailed,
      stoppedEarly: true,
      canceled: false,
    });
  }

  // The crawl finished its frontier; anything still saved would mislead a later retry.
  await deps.progress.clearFrontier(input.crawlId);

  // How discovery found the pages is a scoring input, not a log line: the technical
  // component gives 10% for having a sitemap at all (AI-Pipeline §3.5), and this is the
  // only moment we know.
  await deps.crawls.mergeAnalysis(input.crawlId, {
    discovery: {
      source: result.discoverySource,
      sitemapPresent: result.discoverySource === "sitemap",
      pagesDiscovered: result.pagesDiscovered,
    },
  });

  await deps.crawls.markAnalyzing(input.crawlId);
  await deps.progress.setCrawlProgress(input.crawlId, {
    stage: "analyzing",
    message: "Making sense of what we found…",
    pagesCrawled,
    pagesFound,
    currentUrl: null,
  });

  return ok({
    crawlId: input.crawlId,
    pagesCrawled,
    pagesChanged,
    pagesFailed,
    stoppedEarly: result.stoppedEarly,
    canceled: false,
  });
}
