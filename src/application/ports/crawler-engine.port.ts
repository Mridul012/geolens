/**
 * The crawler behind a port (Engineering-Rules §2.2). The use case orchestrates a crawl;
 * it never learns whether pages arrive via a headless browser or a plain socket.
 */

export interface FetchedPage {
  /** Normalized URL the content was served from, after redirects. */
  readonly url: string;
  readonly status: number;
  readonly html: string;
  readonly fetchedAt: Date;
  readonly redirectChain: readonly string[];
}

export interface PageFailure {
  readonly url: string;
  readonly reason: string;
  readonly status: number | null;
}

export interface CrawlSiteOptions {
  /** Site root; discovery starts here. */
  readonly startUrl: string;
  readonly siteHost: string;
  /** Hard cap for this crawl — the plan's page limit (PRD FR-3.2). */
  readonly maxPages: number;
  /**
   * URLs a previous, interrupted attempt already captured — they are not fetched again.
   *
   * Discovery still runs, so a site with a sitemap resumes completely. A site discovered
   * only by following links resumes partially, because the links of a skipped page are
   * never re-derived; the persisted frontier checkpoint that closes that gap is M7.
   */
  readonly alreadyFetched?: readonly string[];
  /** Called for each page as it lands, so writes stream rather than buffering a crawl. */
  readonly onPage: (page: FetchedPage) => Promise<void>;
  readonly onFailure?: (failure: PageFailure) => Promise<void>;
  /** Called when discovery finishes, so progress can show a real denominator. */
  readonly onDiscovered?: (count: number) => Promise<void>;
  /**
   * A frontier saved by an interrupted attempt. Supplying it makes resume complete even
   * for sites with no sitemap, whose link-derived URLs would otherwise be lost.
   */
  readonly resumeFrontier?: readonly string[];
  /**
   * Called as the frontier shrinks so the caller can persist a checkpoint. Invoked at safe
   * points only — never mid-page — so a saved frontier is always consistent with what has
   * already been written.
   */
  readonly onFrontier?: (remaining: readonly string[]) => Promise<void>;
  /** Polled at safe points: cancellation and shutdown both stop a crawl cleanly. */
  readonly shouldStop?: () => Promise<boolean> | boolean;
}

export interface CrawlSiteResult {
  readonly pagesDiscovered: number;
  readonly pagesCrawled: number;
  readonly pagesFailed: number;
  readonly stoppedEarly: boolean;
  /** Frontier at the moment we stopped — the checkpoint a resumed crawl continues from. */
  readonly remainingFrontier: readonly string[];
  readonly discoverySource: "sitemap" | "links" | "seed";
}

export interface CrawlerEngine {
  crawlSite(options: CrawlSiteOptions): Promise<CrawlSiteResult>;
}
