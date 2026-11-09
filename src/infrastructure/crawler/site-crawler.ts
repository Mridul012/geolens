/**
 * The CrawlerEngine: discovery, frontier management, politeness and the page cap
 * (docs/Architecture.md Stage 1, PRD FR-3.1–3.2).
 *
 * Deliberately not Crawlee's `PlaywrightCrawler`: this crawl needs a frontier we can
 * checkpoint and resume (M7), a per-crawl time budget, cancellation checked at safe points,
 * and every single fetch routed through our SSRF guard. Crawlee's request queue is
 * Redis-less and its autoscaling pool would fight the BullMQ concurrency policy that
 * already caps this worker. The pieces we would have used — Playwright driving, retry,
 * politeness — are small and are here, under our own control, where the guard is
 * unbypassable.
 *
 * Pages stream to `onPage` as they land rather than accumulating: a 100-page crawl must
 * never hold 100 rendered documents in memory (Engineering-Rules §13).
 */
import type {
  CrawlSiteOptions,
  CrawlSiteResult,
  CrawlerEngine,
} from "../../application/ports/crawler-engine.port.js";
import { crawlDelayFor, isPathAllowed, type RobotsTxt } from "../../domain/crawl/robots.js";
import { normalizePageUrl, normalizeSiteUrl } from "../../domain/crawl/url.js";
import { extractPage } from "./extractors/html.js";
import { PageFetchError, type PageFetcher } from "./page-fetcher.js";
import { discoverFromSitemaps, fetchRobots } from "./sitemap.js";
import type { DnsResolver, Transport } from "./ssrf-guard.js";

export interface SiteCrawlerOptions {
  readonly fetcher: PageFetcher;
  readonly userAgent: string;
  readonly timeoutMs: number;
  /** Floor for the per-domain delay; robots.txt may raise it, never lower it. */
  readonly delayMs: number;
  readonly timeBudgetMs: number;
  readonly resolver?: DnsResolver;
  /** Test seam, threaded to the guard; defaults to a real pinned socket. */
  readonly transport?: Transport;
  /** Injectable so tests need not actually wait out politeness delays. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SiteCrawler implements CrawlerEngine {
  readonly #options: SiteCrawlerOptions;

  constructor(options: SiteCrawlerOptions) {
    this.#options = options;
  }

  async crawlSite(options: CrawlSiteOptions): Promise<CrawlSiteResult> {
    const sleep = this.#options.sleep ?? defaultSleep;
    const now = this.#options.now ?? Date.now;
    const startedAt = now();
    const deadline = startedAt + this.#options.timeBudgetMs;

    const root = normalizeSiteUrl(options.startUrl);
    if (!root.ok) {
      throw new PageFetchError(`site URL rejected: ${root.reason}`, null);
    }
    const origin = root.value.origin;

    const discoveryOptions = {
      siteOrigin: origin,
      siteHost: options.siteHost,
      userAgent: this.#options.userAgent,
      timeoutMs: this.#options.timeoutMs,
      maxUrls: options.maxPages * 3,
      ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
      ...(this.#options.transport === undefined ? {} : { transport: this.#options.transport }),
    };

    // We honour robots.txt for our own crawler — a documented product commitment, not a
    // nicety (PRD security & privacy).
    const robots: RobotsTxt = await fetchRobots(discoveryOptions);
    const robotsDelaySeconds = crawlDelayFor(robots, this.#options.userAgent);
    const delayMs = Math.max(
      this.#options.delayMs,
      robotsDelaySeconds === null ? 0 : robotsDelaySeconds * 1_000,
    );

    const discovered = await discoverFromSitemaps(discoveryOptions, robots);
    const discoverySource: CrawlSiteResult["discoverySource"] =
      discovered.urls.length > 0 ? "sitemap" : "links";

    const visited = new Set<string>(options.alreadyFetched ?? []);
    const queued = new Set<string>();
    const frontier: string[] = [];

    const enqueue = (url: string): void => {
      if (visited.has(url) || queued.has(url)) return;
      queued.add(url);
      frontier.push(url);
    };

    // A saved frontier leads: it holds link-derived URLs that discovery alone cannot
    // recover, so an interrupted crawl continues instead of re-deriving.
    for (const url of options.resumeFrontier ?? []) enqueue(url);

    // The homepage always leads otherwise: highest-authority page, and the taxonomy's seed.
    enqueue(`${origin}/`);
    for (const url of discovered.urls) enqueue(url);

    await options.onDiscovered?.(Math.max(frontier.length, discovered.urls.length));

    let pagesCrawled = 0;
    let pagesFailed = 0;
    let stoppedEarly = false;

    while (frontier.length > 0 && pagesCrawled < options.maxPages) {
      if (now() > deadline) {
        // A site that will not finish must still end (PRD NFR: crawl < 15 min p90).
        stoppedEarly = true;
        break;
      }
      if ((await options.shouldStop?.()) === true) {
        stoppedEarly = true;
        break;
      }

      const url = frontier.shift() as string;
      queued.delete(url);
      if (visited.has(url)) continue;
      visited.add(url);

      const path = new URL(url).pathname;
      if (!isPathAllowed(robots, this.#options.userAgent, path).allowed) {
        // Not a failure: the site asked us not to, and we listen.
        continue;
      }

      try {
        const page = await this.#options.fetcher.fetch(url);
        pagesCrawled += 1;
        await options.onPage(page);

        // Link-following keeps the frontier fed when there is no sitemap, and fills gaps
        // when the sitemap is stale.
        if (frontier.length + pagesCrawled < options.maxPages * 2) {
          const extracted = extractPage(page.html, {
            pageUrl: page.url,
            siteHost: options.siteHost,
          });
          for (const link of extracted.links) {
            if (!link.internal) continue;
            const normalized = normalizePageUrl(link.href);
            if (!normalized.ok) continue;
            if (normalized.value.hostname !== options.siteHost) continue;
            enqueue(normalized.value.href);
          }
        }
      } catch (error) {
        pagesFailed += 1;
        const failure =
          error instanceof PageFetchError
            ? { url, reason: error.message, status: error.status }
            : { url, reason: (error as Error).message, status: null };
        await options.onFailure?.(failure);
      }

      // Checkpointed between pages, never mid-page: what is saved always matches what has
      // been written, so a resumed crawl neither repeats nor skips.
      await options.onFrontier?.(frontier);

      // Politeness: one page at a time per domain, with a gap between requests. Conservative
      // by design — being throttled or blocked costs far more than being slow.
      if (frontier.length > 0 && delayMs > 0) await sleep(delayMs);
    }

    return {
      pagesDiscovered: visited.size + frontier.length,
      pagesCrawled,
      pagesFailed,
      stoppedEarly: stoppedEarly || frontier.length > 0,
      remainingFrontier: frontier,
      discoverySource: pagesCrawled === 0 ? "seed" : discoverySource,
    };
  }
}
