/**
 * The crawler against a real fixture site (M6 tests): sitemap discovery with link-following
 * fallback, the page cap, robots honoured, politeness, and clean stops.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SiteCrawler } from "../../../src/infrastructure/crawler/site-crawler.js";
import { HttpPageFetcher } from "../../../src/infrastructure/crawler/page-fetcher.js";
import type { FetchedPage, PageFailure } from "../../../src/application/ports/crawler-engine.port.js";
import { fixturePage, startFixtureSite, type FixtureSite } from "../../helpers/fixture-site.js";

let site: FixtureSite | null = null;

afterEach(async () => {
  await site?.close();
  site = null;
});

interface CrawlOutcome {
  readonly pages: FetchedPage[];
  readonly failures: PageFailure[];
  readonly result: Awaited<ReturnType<SiteCrawler["crawlSite"]>>;
  readonly slept: number[];
}

async function crawl(
  fixture: FixtureSite,
  options: { maxPages?: number; delayMs?: number; shouldStop?: () => boolean } = {},
): Promise<CrawlOutcome> {
  const pages: FetchedPage[] = [];
  const failures: PageFailure[] = [];
  const slept: number[] = [];

  const crawler = new SiteCrawler({
    fetcher: new HttpPageFetcher({
      userAgent: "VryseBot/1.0 (+https://vryse.example/bot)",
      timeoutMs: 5_000,
      resolver: fixture.resolver,
      transport: fixture.transport,
    }),
    userAgent: "VryseBot/1.0 (+https://vryse.example/bot)",
    timeoutMs: 5_000,
    delayMs: options.delayMs ?? 0,
    timeBudgetMs: 30_000,
    resolver: fixture.resolver,
    transport: fixture.transport,
    // Politeness is recorded rather than waited out, so the suite stays fast.
    sleep: async (ms) => void slept.push(ms),
  });

  const result = await crawler.crawlSite({
    startUrl: fixture.origin,
    siteHost: fixture.host,
    maxPages: options.maxPages ?? 25,
    onPage: async (page) => void pages.push(page),
    onFailure: async (failure) => void failures.push(failure),
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
  });

  return { pages, failures, result, slept };
}

describe("discovery via sitemap", () => {
  it("crawls the pages the sitemap declares", async () => {
    site = await startFixtureSite({
      "/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.xml" },
      "/sitemap.xml": {
        contentType: "application/xml",
        body: `<?xml version="1.0"?><urlset>
          <url><loc>https://acme.com/pricing</loc></url>
          <url><loc>https://acme.com/docs</loc></url>
          <url><loc>https://acme.com/about</loc></url>
        </urlset>`,
      },
      "/": fixturePage("Home"),
      "/pricing": fixturePage("Pricing"),
      "/docs": fixturePage("Docs"),
      "/about": fixturePage("About"),
    });

    const { pages, result } = await crawl(site);

    expect(result.discoverySource).toBe("sitemap");
    expect(result.pagesCrawled).toBe(4);
    expect(pages.map((page) => new URL(page.url).pathname).sort()).toEqual([
      "/",
      "/about",
      "/docs",
      "/pricing",
    ]);
    expect(pages.every((page) => page.html.includes("<h1>"))).toBe(true);
  });

  it("follows a sitemap index one level", async () => {
    site = await startFixtureSite({
      "/robots.txt": { body: "User-agent: *\nAllow: /" },
      "/sitemap.xml": {
        contentType: "application/xml",
        body: `<?xml version="1.0"?><sitemapindex>
          <sitemap><loc>https://acme.com/sitemap-pages.xml</loc></sitemap>
        </sitemapindex>`,
      },
      "/sitemap-pages.xml": {
        contentType: "application/xml",
        body: `<?xml version="1.0"?><urlset>
          <url><loc>https://acme.com/deep</loc></url>
        </urlset>`,
      },
      "/": fixturePage("Home"),
      "/deep": fixturePage("Deep"),
    });

    const { result, pages } = await crawl(site);
    expect(result.pagesCrawled).toBe(2);
    expect(pages.map((page) => new URL(page.url).pathname)).toContain("/deep");
  });

  it("ignores sitemap entries pointing at another domain", async () => {
    site = await startFixtureSite({
      "/robots.txt": { body: "User-agent: *\nAllow: /" },
      "/sitemap.xml": {
        contentType: "application/xml",
        body: `<?xml version="1.0"?><urlset>
          <url><loc>https://acme.com/ours</loc></url>
          <url><loc>https://evil.example/theirs</loc></url>
        </urlset>`,
      },
      "/": fixturePage("Home"),
      "/ours": fixturePage("Ours"),
    });

    const { pages } = await crawl(site);
    expect(pages.every((page) => page.url.startsWith("https://acme.com"))).toBe(true);
  });
});

describe("discovery via link-following", () => {
  it("falls back to links when there is no sitemap", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/pricing", "/docs", "https://external.example/x"]),
      "/pricing": fixturePage("Pricing", ["/pricing/enterprise"]),
      "/pricing/enterprise": fixturePage("Enterprise"),
      "/docs": fixturePage("Docs"),
    });

    const { result, pages } = await crawl(site);

    expect(result.discoverySource).toBe("links");
    expect(pages.map((page) => new URL(page.url).pathname).sort()).toEqual([
      "/",
      "/docs",
      "/pricing",
      "/pricing/enterprise",
    ]);
  });

  it("never leaves the site", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["https://external.example/page", "/ours"]),
      "/ours": fixturePage("Ours"),
    });

    const { pages } = await crawl(site);
    expect(pages.every((page) => new URL(page.url).hostname === "acme.com")).toBe(true);
  });

  it("visits a page once however many times it is linked", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/a", "/a/", "https://www.acme.com/a"]),
      "/a": fixturePage("A", ["/"]),
    });

    const { pages } = await crawl(site);
    expect(pages.filter((page) => new URL(page.url).pathname === "/a")).toHaveLength(1);
    expect(pages.filter((page) => new URL(page.url).pathname === "/")).toHaveLength(1);
  });
});

describe("limits and politeness", () => {
  it("stops at the page cap", async () => {
    const routes: Record<string, ReturnType<typeof fixturePage>> = {
      "/": fixturePage(
        "Home",
        Array.from({ length: 20 }, (_unused, index) => `/page-${index}`),
      ),
    };
    for (let index = 0; index < 20; index += 1) {
      routes[`/page-${index}`] = fixturePage(`Page ${index}`);
    }
    site = await startFixtureSite(routes);

    const { result, pages } = await crawl(site, { maxPages: 5 });

    expect(result.pagesCrawled).toBe(5);
    expect(pages).toHaveLength(5);
    // The rest survives as a checkpoint rather than being silently dropped.
    expect(result.remainingFrontier.length).toBeGreaterThan(0);
    expect(result.stoppedEarly).toBe(true);
  });

  it("waits between requests to the same domain", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/a", "/b"]),
      "/a": fixturePage("A"),
      "/b": fixturePage("B"),
    });

    const { slept } = await crawl(site, { delayMs: 500 });
    expect(slept.length).toBeGreaterThan(0);
    expect(slept.every((ms) => ms >= 500)).toBe(true);
  });

  it("raises its delay to honour Crawl-delay", async () => {
    site = await startFixtureSite({
      "/robots.txt": { body: "User-agent: *\nAllow: /\nCrawl-delay: 3" },
      "/": fixturePage("Home", ["/a"]),
      "/a": fixturePage("A"),
    });

    const { slept } = await crawl(site, { delayMs: 500 });
    expect(slept.every((ms) => ms === 3_000)).toBe(true);
  });

  it("identifies itself on every request", async () => {
    site = await startFixtureSite({ "/": fixturePage("Home") });
    await crawl(site);

    const agents = site.requestHeaders().map((entry) => entry.userAgent);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((agent) => agent?.includes("VryseBot") === true)).toBe(true);
  });
});

describe("robots.txt is honoured for our own crawler", () => {
  it("skips disallowed paths without counting them as failures", async () => {
    site = await startFixtureSite({
      "/robots.txt": { body: "User-agent: *\nDisallow: /private" },
      "/": fixturePage("Home", ["/public", "/private/secret"]),
      "/public": fixturePage("Public"),
      "/private/secret": fixturePage("Secret"),
    });

    const { pages, result } = await crawl(site);

    const paths = pages.map((page) => new URL(page.url).pathname);
    expect(paths).toContain("/public");
    expect(paths).not.toContain("/private/secret");
    expect(result.pagesFailed).toBe(0);
    expect(site.requests()).not.toContain("/private/secret");
  });

  it("crawls everything when robots.txt is absent", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/a"]),
      "/a": fixturePage("A"),
    });

    const { result } = await crawl(site);
    expect(result.pagesCrawled).toBe(2);
  });
});

describe("failure handling", () => {
  it("records a failing page and keeps crawling", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/broken", "/fine"]),
      "/broken": { status: 500, body: "boom" },
      "/fine": fixturePage("Fine"),
    });

    const { pages, failures, result } = await crawl(site);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.status).toBe(500);
    expect(result.pagesFailed).toBe(1);
    expect(pages.map((page) => new URL(page.url).pathname)).toContain("/fine");
  });

  it("follows a redirect and records the destination", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/old"]),
      "/old": { status: 301, body: "", headers: { location: "https://acme.com/new" } },
      "/new": fixturePage("New"),
    });

    const { pages } = await crawl(site);
    const moved = pages.find((page) => page.url.endsWith("/new"));
    expect(moved).toBeDefined();
    expect(moved?.redirectChain).toContain("https://acme.com/old");
  });
});

describe("stopping cleanly", () => {
  it("stops when asked and reports what was left", async () => {
    const routes: Record<string, ReturnType<typeof fixturePage>> = {
      "/": fixturePage(
        "Home",
        Array.from({ length: 10 }, (_unused, index) => `/page-${index}`),
      ),
    };
    for (let index = 0; index < 10; index += 1) {
      routes[`/page-${index}`] = fixturePage(`Page ${index}`);
    }
    site = await startFixtureSite(routes);

    let crawled = 0;
    const { result } = await crawl(site, {
      shouldStop: () => {
        crawled += 1;
        return crawled > 3;
      },
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.pagesCrawled).toBeLessThan(11);
    expect(result.remainingFrontier.length).toBeGreaterThan(0);
  });

  it("does not re-fetch pages a previous attempt already got", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/a", "/b"]),
      "/a": fixturePage("A"),
      "/b": fixturePage("B"),
    });

    const crawler = new SiteCrawler({
      fetcher: new HttpPageFetcher({
        userAgent: "VryseBot/1.0",
        timeoutMs: 5_000,
        resolver: site.resolver,
        transport: site.transport,
      }),
      userAgent: "VryseBot/1.0",
      timeoutMs: 5_000,
      delayMs: 0,
      timeBudgetMs: 30_000,
      resolver: site.resolver,
      transport: site.transport,
      sleep: async () => undefined,
    });

    const pages: string[] = [];
    await crawler.crawlSite({
      startUrl: site.origin,
      siteHost: site.host,
      maxPages: 25,
      alreadyFetched: ["https://acme.com/a"],
      onPage: async (page) => void pages.push(new URL(page.url).pathname),
    });

    expect(pages).not.toContain("/a");
    expect(pages).toContain("/b");
  });
});
