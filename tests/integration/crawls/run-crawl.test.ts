/**
 * The crawl pipeline end to end (M6 acceptance): a real fixture site is crawled over real
 * sockets, snapshots are gzipped into real object storage, and `pages` / `page_snapshots`
 * land in real Postgres with their extracted columns populated.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { runCrawl } from "../../../src/application/crawls/run-crawl.js";
import { finalizeCrawl } from "../../../src/application/crawls/finalize-crawl.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../../../src/infrastructure/db/repositories/events.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { RedisProgressStore } from "../../../src/infrastructure/redis/progress-store.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import {
  S3ObjectStorage,
  createS3Client,
} from "../../../src/infrastructure/storage/s3-object-storage.js";
import { SiteCrawler } from "../../../src/infrastructure/crawler/site-crawler.js";
import { HttpPageFetcher } from "../../../src/infrastructure/crawler/page-fetcher.js";
import { extractPage } from "../../../src/infrastructure/crawler/extractors/html.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";
import { fixturePage, startFixtureSite, type FixtureSite } from "../../helpers/fixture-site.js";

let prisma: PrismaClient;
let redis: RedisClient;
let storage: S3ObjectStorage;
let site: FixtureSite | null = null;

const log = pino({ level: "silent" });

interface Seeded {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
}

async function seedCrawl(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `crawl-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: "Crawl fixture" },
  });
  const siteRow = await prisma.site.create({
    data: {
      projectId: project.id,
      url: "https://acme.com",
      domain: "acme.com",
      role: "OWN",
    },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: siteRow.id,
      projectId: project.id,
      status: "QUEUED",
      trigger: "MANUAL",
    },
  });
  return { projectId: project.id, siteId: siteRow.id, crawlId: crawl.id };
}

function pipelineDeps(fixture: FixtureSite, shouldStop?: () => boolean) {
  const engine = new SiteCrawler({
    fetcher: new HttpPageFetcher({
      userAgent: "GEOlensBot/1.0",
      timeoutMs: 5_000,
      resolver: fixture.resolver,
      transport: fixture.transport,
    }),
    userAgent: "GEOlensBot/1.0",
    timeoutMs: 5_000,
    delayMs: 0,
    timeBudgetMs: 30_000,
    resolver: fixture.resolver,
    transport: fixture.transport,
    sleep: async () => undefined,
  });

  return {
    crawls: new CrawlsRepo(prisma),
    sites: new SitesRepo(prisma),
    projects: new ProjectsRepo(prisma),
    users: new UsersRepo(prisma),
    events: new EventsRepo(prisma),
    engine,
    storage,
    progress: new RedisProgressStore(redis),
    extract: extractPage,
    log,
    ...(shouldStop === undefined ? {} : { shouldStop }),
  };
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  storage = new S3ObjectStorage(createS3Client());
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterEach(async () => {
  await site?.close();
  site = null;
});

describe("runCrawl", () => {
  it("crawls a site, stores gzipped snapshots, and populates the extracted columns", async () => {
    site = await startFixtureSite({
      "/robots.txt": { body: "User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.xml" },
      "/sitemap.xml": {
        contentType: "application/xml",
        body: `<?xml version="1.0"?><urlset>
          <url><loc>https://acme.com/pricing</loc></url>
          <url><loc>https://acme.com/docs</loc></url>
        </urlset>`,
      },
      "/": fixturePage("Home", ["/pricing"]),
      "/pricing": fixturePage(
        "Pricing",
        [],
        `<script type="application/ld+json">{"@type":"Product","name":"Acme Pro"}</script>
         <img src="/a.png" alt="chart" />`,
      ),
      "/docs": fixturePage("Docs"),
    });

    const seeded = await seedCrawl();
    const result = await runCrawl(pipelineDeps(site), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pagesCrawled).toBe(3);
    expect(result.value.pagesChanged).toBe(3);
    expect(result.value.pagesFailed).toBe(0);

    // Rows exist with real extracted columns, not placeholders.
    const snapshots = await prisma.pageSnapshot.findMany({
      include: { page: true },
      orderBy: { createdAt: "asc" },
    });
    expect(snapshots).toHaveLength(3);

    const pricing = snapshots.find((row) => row.page.url.endsWith("/pricing"));
    expect(pricing).toBeDefined();
    expect(pricing?.title).toBe("Pricing");
    expect(pricing?.httpStatus).toBe(200);
    expect(pricing?.changed).toBe(true);
    expect(pricing?.wordCount).toBeGreaterThan(10);
    expect(pricing?.hasStructuredData).toBe(true);
    expect(pricing?.storageKey).toMatch(
      new RegExp(`^snapshots/${seeded.projectId}/${seeded.crawlId}/[0-9a-f]{64}\\.html\\.gz$`),
    );

    // The snapshot in storage is the real page, gzipped.
    const stored = await storage.get(pricing?.storageKey ?? "");
    expect(stored).not.toBeNull();
    const html = gunzipSync(Buffer.from(stored as Uint8Array)).toString("utf8");
    expect(html).toContain("<h1>Pricing</h1>");

    // The crawl moved to ANALYZING, ready for the fan-in.
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    expect(crawl.status).toBe("ANALYZING");
    expect(crawl.pagesCrawled).toBe(3);
    expect(crawl.startedAt).not.toBeNull();
  });

  it("narrates progress to the store the SSE stream reads", async () => {
    site = await startFixtureSite({ "/": fixturePage("Home", ["/a"]), "/a": fixturePage("A") });
    const seeded = await seedCrawl();
    const progress = new RedisProgressStore(redis);

    await runCrawl(pipelineDeps(site), seeded);

    const state = await progress.getCrawlProgress(seeded.crawlId);
    expect(state).not.toBeNull();
    expect(state?.stage).toBe("analyzing");
    expect(state?.pagesCrawled).toBe(2);
    expect(state?.message.length).toBeGreaterThan(0);
  });

  it("detects unchanged pages on a re-crawl and carries the lineage forward", async () => {
    site = await startFixtureSite({ "/": fixturePage("Home", ["/a"]), "/a": fixturePage("A") });
    const seeded = await seedCrawl();

    await runCrawl(pipelineDeps(site), seeded);
    await prisma.crawl.update({
      where: { id: seeded.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const second = await prisma.crawl.create({
      data: {
        siteId: seeded.siteId,
        projectId: seeded.projectId,
        status: "QUEUED",
        trigger: "MANUAL",
      },
    });
    const result = await runCrawl(pipelineDeps(site), { ...seeded, crawlId: second.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pagesCrawled).toBe(2);
    // Nothing on the site moved, so nothing is re-analysed downstream.
    expect(result.value.pagesChanged).toBe(0);

    const snapshots = await prisma.pageSnapshot.findMany({ where: { crawlId: second.id } });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((row) => row.changed === false)).toBe(true);
    expect(snapshots.every((row) => row.carriedForwardFromId !== null)).toBe(true);
  });

  it("marks only the edited page as changed", async () => {
    site = await startFixtureSite({ "/": fixturePage("Home", ["/a"]), "/a": fixturePage("A") });
    const seeded = await seedCrawl();
    await runCrawl(pipelineDeps(site), seeded);
    await prisma.crawl.update({ where: { id: seeded.crawlId }, data: { status: "COMPLETED" } });
    await site.close();

    // Same site, one page rewritten.
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/a"]),
      "/a": fixturePage("A — substantially rewritten with different prose entirely"),
    });

    const second = await prisma.crawl.create({
      data: {
        siteId: seeded.siteId,
        projectId: seeded.projectId,
        status: "QUEUED",
        trigger: "MANUAL",
      },
    });
    const result = await runCrawl(pipelineDeps(site), { ...seeded, crawlId: second.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pagesChanged).toBe(1);

    const changed = await prisma.pageSnapshot.findMany({
      where: { crawlId: second.id, changed: true },
      include: { page: true },
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]?.page.url).toBe("https://acme.com/a");
  });

  it("keeps captured pages when cancelled mid-crawl", async () => {
    const routes: Record<string, ReturnType<typeof fixturePage>> = {
      "/": fixturePage(
        "Home",
        Array.from({ length: 8 }, (_unused, index) => `/page-${index}`),
      ),
    };
    for (let index = 0; index < 8; index += 1) routes[`/page-${index}`] = fixturePage(`P${index}`);
    site = await startFixtureSite(routes);

    const seeded = await seedCrawl();
    const progress = new RedisProgressStore(redis);
    await progress.requestCancel(seeded.crawlId);

    const result = await runCrawl(pipelineDeps(site), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.canceled).toBe(true);

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    expect(crawl.status).toBe("CANCELED");
    // Partial data is retained, not rolled back.
    expect(crawl.pagesCrawled).toBe(result.value.pagesCrawled);
  });

  it("resumes from what a previous attempt already captured", async () => {
    // A declared sitemap is what makes resume complete today: discovery re-enumerates the
    // frontier, and `alreadyFetched` stops the captured pages being paid for twice. Sites
    // with no sitemap resume partially until the frontier checkpoint lands in M7.
    site = await startFixtureSite({
      "/sitemap.xml": {
        contentType: "application/xml",
        body: `<?xml version="1.0"?><urlset>
          <url><loc>https://acme.com/a</loc></url>
          <url><loc>https://acme.com/b</loc></url>
        </urlset>`,
      },
      "/": fixturePage("Home", ["/a", "/b"]),
      "/a": fixturePage("A"),
      "/b": fixturePage("B"),
    });
    const seeded = await seedCrawl();

    // First attempt is drained after its first page.
    let pagesSeen = 0;
    await runCrawl(
      pipelineDeps(site, () => pagesSeen++ >= 1),
      seeded,
    );
    const afterFirst = await prisma.pageSnapshot.count({ where: { crawlId: seeded.crawlId } });
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(3);

    // The retry picks up rather than starting over.
    const result = await runCrawl(pipelineDeps(site), seeded);
    expect(result.ok).toBe(true);
    const total = await prisma.pageSnapshot.count({ where: { crawlId: seeded.crawlId } });
    expect(total).toBe(3);
  });

  it("counts a failing page without failing the crawl", async () => {
    site = await startFixtureSite({
      "/": fixturePage("Home", ["/broken", "/fine"]),
      "/broken": { status: 500, body: "boom" },
      "/fine": fixturePage("Fine"),
    });
    const seeded = await seedCrawl();

    const result = await runCrawl(pipelineDeps(site), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pagesFailed).toBe(1);
    expect(result.value.pagesCrawled).toBe(2);
  });
});

describe("finalizeCrawl", () => {
  it("completes the crawl and writes the crawl_completed event", async () => {
    site = await startFixtureSite({ "/": fixturePage("Home") });
    const seeded = await seedCrawl();
    await runCrawl(pipelineDeps(site), seeded);

    const crawl = await finalizeCrawl(
      {
        crawls: new CrawlsRepo(prisma),
        events: new EventsRepo(prisma),
        progress: new RedisProgressStore(redis),
      },
      {
        crawlId: seeded.crawlId,
        projectId: seeded.projectId,
        pagesCrawled: 1,
        pagesChanged: 1,
        pagesFailed: 0,
      },
    );

    expect(crawl.status).toBe("COMPLETED");
    expect(crawl.finishedAt).not.toBeNull();

    const events = await prisma.event.findMany({ where: { projectId: seeded.projectId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("crawl_completed");
    expect(events[0]?.crawlId).toBe(seeded.crawlId);

    const progress = await new RedisProgressStore(redis).getCrawlProgress(seeded.crawlId);
    expect(progress?.stage).toBe("done");
    expect(progress?.status).toBe("COMPLETED");
  });

  it("degrades rather than failing when a minority of pages could not be read", async () => {
    const seeded = await seedCrawl();
    const crawl = await finalizeCrawl(
      {
        crawls: new CrawlsRepo(prisma),
        events: new EventsRepo(prisma),
        progress: new RedisProgressStore(redis),
      },
      {
        crawlId: seeded.crawlId,
        projectId: seeded.projectId,
        pagesCrawled: 5,
        pagesChanged: 5,
        pagesFailed: 5,
      },
    );

    expect(crawl.status).toBe("COMPLETED_DEGRADED");
    expect(crawl.degradation).toMatchObject({ pages: { failed: 5, attempted: 10 } });
  });

  it("fails honestly when nothing at all was readable", async () => {
    const seeded = await seedCrawl();
    const crawl = await finalizeCrawl(
      {
        crawls: new CrawlsRepo(prisma),
        events: new EventsRepo(prisma),
        progress: new RedisProgressStore(redis),
      },
      {
        crawlId: seeded.crawlId,
        projectId: seeded.projectId,
        pagesCrawled: 0,
        pagesChanged: 0,
        pagesFailed: 0,
      },
    );

    expect(crawl.status).toBe("FAILED");
    expect(crawl.errorReason).toContain("could not read any pages");

    const events = await prisma.event.findMany();
    expect(events[0]?.kind).toBe("crawl_failed");
  });
});
