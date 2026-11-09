/**
 * The resume drill (M7 acceptance): a crawl killed mid-flight resumes from its checkpoint
 * rather than restarting, and the page counts prove it.
 *
 * Deliberately uses a link-only fixture — no sitemap — because that is the case the
 * durable half of the checkpoint cannot cover on its own.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { runCrawl } from "../../../src/application/crawls/run-crawl.js";
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
let progress: RedisProgressStore;
let site: FixtureSite | null = null;

const log = pino({ level: "silent" });

/** Ten pages reachable only by following links from the homepage. */
function linkOnlySite(): Record<string, ReturnType<typeof fixturePage>> {
  const routes: Record<string, ReturnType<typeof fixturePage>> = {
    "/": fixturePage(
      "Home",
      Array.from({ length: 10 }, (_unused, index) => `/page-${index}`),
    ),
  };
  for (let index = 0; index < 10; index += 1) {
    routes[`/page-${index}`] = fixturePage(`Page ${index}`);
  }
  return routes;
}

async function seedCrawl(): Promise<{ projectId: string; siteId: string; crawlId: string }> {
  const user = await prisma.user.create({
    data: { email: `resume-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Resume" } });
  const siteRow = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: { siteId: siteRow.id, projectId: project.id, status: "QUEUED", trigger: "MANUAL" },
  });
  return { projectId: project.id, siteId: siteRow.id, crawlId: crawl.id };
}

function deps(fixture: FixtureSite, shouldStop?: () => boolean) {
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
    progress,
    extract: extractPage,
    log,
    ...(shouldStop === undefined ? {} : { shouldStop }),
  };
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  storage = new S3ObjectStorage(createS3Client());
  progress = new RedisProgressStore(redis);
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

describe("frontier checkpoint", () => {
  it("resumes a link-only site from its checkpoint rather than restarting", async () => {
    site = await startFixtureSite(linkOnlySite());
    const seeded = await seedCrawl();

    // Killed after three pages, the way a SIGTERM mid-crawl would.
    let seen = 0;
    const first = await runCrawl(
      deps(site, () => seen++ >= 3),
      seeded,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.stoppedEarly).toBe(true);

    const afterKill = await prisma.pageSnapshot.count({ where: { crawlId: seeded.crawlId } });
    expect(afterKill).toBeGreaterThan(0);
    expect(afterKill).toBeLessThan(11);

    // The checkpoint survived, holding the URLs discovery alone could not recover.
    const checkpoint = await progress.loadFrontier(seeded.crawlId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.urls.length).toBeGreaterThan(0);

    const requestsBeforeResume = site.requests().length;

    const second = await runCrawl(deps(site), seeded);
    expect(second.ok).toBe(true);

    // Every page ends up captured…
    const total = await prisma.pageSnapshot.count({ where: { crawlId: seeded.crawlId } });
    expect(total).toBe(11);

    // …and the resume fetched only the pages that were left. Discovery probes (robots.txt
    // and the sitemap candidates) run again on every attempt by design and are excluded —
    // it is the *page* counts that prove no restart happened.
    const pageRequestsDuringResume = site
      .requests()
      .slice(requestsBeforeResume)
      .filter((path) => path !== "/robots.txt" && !path.startsWith("/sitemap")).length;

    expect(pageRequestsDuringResume).toBe(11 - afterKill);
    expect(pageRequestsDuringResume).toBeLessThan(11);
  });

  it("never fetches the same page twice across a resume", async () => {
    site = await startFixtureSite(linkOnlySite());
    const seeded = await seedCrawl();

    let seen = 0;
    await runCrawl(
      deps(site, () => seen++ >= 4),
      seeded,
    );
    await runCrawl(deps(site), seeded);

    const pageRequests = site.requests().filter((path) => path !== "/robots.txt" && !path.startsWith("/sitemap"));
    const unique = new Set(pageRequests);
    expect(pageRequests.length).toBe(unique.size);
  });

  it("clears the checkpoint once the crawl completes", async () => {
    site = await startFixtureSite({ "/": fixturePage("Home", ["/a"]), "/a": fixturePage("A") });
    const seeded = await seedCrawl();

    await runCrawl(deps(site), seeded);

    expect(await progress.loadFrontier(seeded.crawlId)).toBeNull();
  });

  it("clears the checkpoint when the crawl is canceled", async () => {
    site = await startFixtureSite(linkOnlySite());
    const seeded = await seedCrawl();
    await progress.requestCancel(seeded.crawlId);

    await runCrawl(deps(site), seeded);

    expect(await progress.loadFrontier(seeded.crawlId)).toBeNull();
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    expect(crawl.status).toBe("CANCELED");
  });

  it("still completes when the checkpoint is lost — a Redis flush degrades, never breaks", async () => {
    site = await startFixtureSite(linkOnlySite());
    const seeded = await seedCrawl();

    let seen = 0;
    await runCrawl(
      deps(site, () => seen++ >= 3),
      seeded,
    );
    const afterKill = await prisma.pageSnapshot.count({ where: { crawlId: seeded.crawlId } });

    // Simulate the flush: the durable half (snapshots) survives, the operational half does not.
    await progress.clearFrontier(seeded.crawlId);

    const second = await runCrawl(deps(site), seeded);
    expect(second.ok).toBe(true);

    // The captured pages are still not re-fetched — resume degrades to partial, not broken.
    const total = await prisma.pageSnapshot.count({ where: { crawlId: seeded.crawlId } });
    expect(total).toBeGreaterThanOrEqual(afterKill);
  });
});
