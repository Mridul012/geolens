/**
 * The dashboard cache (M12 acceptance): build, invalidate, serve.
 *
 * The architectural claim under test is "the dashboard never computes" (docs/Backend.md
 * §4). It is easy to satisfy on a slow path and lose the moment someone adds a query to
 * the read, so the read path is measured against a *stub* set of repositories that throw:
 * a cache hit that touches Postgres fails loudly rather than quietly getting slower.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  buildDashboard,
  dashboardKey,
  invalidateDashboard,
  rebuildDashboard,
  type DashboardDeps,
} from "../../../src/application/dashboard/build-dashboard.js";
import { readDashboard } from "../../../src/application/dashboard/read-dashboard.js";
import { RedisCache } from "../../../src/infrastructure/redis/cache.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { RecommendationsRepo } from "../../../src/infrastructure/db/repositories/recommendations.repo.js";
import { PromptRunsRepo } from "../../../src/infrastructure/db/repositories/prompt-runs.repo.js";
import { systemClock } from "../../../src/application/ports/clock.port.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let redis: RedisClient;
let cache: RedisCache;
let projects: ProjectsRepo;
let deps: DashboardDeps & { projects: ProjectsRepo };

interface Seeded {
  readonly userId: string;
  readonly projectId: string;
  readonly siteId: string;
}

async function seedProject(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `dash-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Dashboard" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  return { userId: user.id, projectId: project.id, siteId: site.id };
}

async function completedCrawl(seeded: Seeded, pages = 3): Promise<string> {
  const crawl = await prisma.crawl.create({
    data: {
      siteId: seeded.siteId,
      projectId: seeded.projectId,
      status: "COMPLETED",
      trigger: "MANUAL",
      pagesCrawled: pages,
      finishedAt: new Date(),
    },
  });
  for (let index = 0; index < pages; index += 1) {
    const page = await prisma.page.create({
      data: {
        siteId: seeded.siteId,
        url: `https://acme.com/p${index}`,
        urlHash: `dash-${crawl.id}-${index}`,
        latestContentHash: `c${index}`,
      },
    });
    await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: page.id,
        contentHash: `c${index}`,
        extracted: {},
        wordCount: 300,
        title: `Page ${index}`,
        storageKey: `k${index}`,
        fetchedAt: new Date(),
      },
    });
  }
  return crawl.id;
}

async function addScore(seeded: Seeded, crawlId: string, composite: number): Promise<void> {
  await new ScoresRepo(prisma).insert({
    projectId: seeded.projectId,
    crawlId,
    promptRunId: null,
    composite,
    citation: null,
    retrievability: 60,
    contentQuality: 70,
    topicCoverage: 50,
    technical: 90,
    trust: 40,
    components: { configVersion: "scoring.v1", components: [] },
    scoringConfigVersion: "scoring.v1",
  });
}

/** Repositories that throw. Anything the read path touches becomes a failure, not a delay. */
function forbiddenRepos(): DashboardDeps {
  const refuse = (name: string): never => {
    throw new Error(`the dashboard read touched ${name}; it is supposed to serve from cache`);
  };
  return {
    cache,
    clock: systemClock,
    crawls: new Proxy({} as CrawlsRepo, { get: () => () => refuse("crawls") }),
    scores: new Proxy({} as ScoresRepo, { get: () => () => refuse("scores") }),
    sites: new Proxy({} as SitesRepo, { get: () => () => refuse("sites") }),
    topics: new Proxy({} as TopicsRepo, { get: () => () => refuse("topics") }),
    coverage: new Proxy({} as TopicCoverageRepo, { get: () => () => refuse("coverage") }),
    chunks: new Proxy({} as ChunksRepo, { get: () => () => refuse("chunks") }),
    recommendations: new Proxy({} as RecommendationsRepo, {
      get: () => () => refuse("recommendations"),
    }),
    runs: new Proxy({} as PromptRunsRepo, { get: () => () => refuse("runs") }),
  };
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  cache = new RedisCache(redis);
  projects = new ProjectsRepo(prisma);
  deps = {
    cache,
    clock: systemClock,
    projects,
    crawls: new CrawlsRepo(prisma),
    scores: new ScoresRepo(prisma),
    sites: new SitesRepo(prisma),
    topics: new TopicsRepo(prisma),
    coverage: new TopicCoverageRepo(prisma),
    chunks: new ChunksRepo(prisma),
    recommendations: new RecommendationsRepo(prisma),
    runs: new PromptRunsRepo(prisma),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
  await redis.flushdb();
});

describe("the empty state", () => {
  it("says there is no completed crawl rather than showing zeros", async () => {
    const seeded = await seedProject();

    const dashboard = await buildDashboard(deps, seeded.projectId);

    expect(dashboard).toMatchObject({
      hasCompletedCrawl: false,
      latestScore: null,
      indexedPages: 0,
      crawlStatus: null,
      promptSummary: null,
      comparisonSummary: null,
    });
    expect(dashboard.scoreTrend).toEqual([]);
    expect(dashboard.recentPages).toEqual([]);
  });

  it("shows a crawl in flight before it has finished", async () => {
    const seeded = await seedProject();
    await prisma.crawl.create({
      data: {
        siteId: seeded.siteId,
        projectId: seeded.projectId,
        status: "CRAWLING",
        trigger: "MANUAL",
      },
    });

    const dashboard = await buildDashboard(deps, seeded.projectId);

    expect(dashboard.hasCompletedCrawl).toBe(false);
    expect(dashboard.crawlStatus?.status).toBe("CRAWLING");
  });

  it("shows the score as pending when a crawl finished but published nothing", async () => {
    const seeded = await seedProject();
    await completedCrawl(seeded);

    const dashboard = await buildDashboard(deps, seeded.projectId);

    expect(dashboard.hasCompletedCrawl).toBe(true);
    // Null is "pending", which the UI renders differently from a score of zero.
    expect(dashboard.latestScore).toBeNull();
  });
});

describe("a populated dashboard", () => {
  it("carries the latest score, the trend, and the pages that were crawled", async () => {
    const seeded = await seedProject();
    const first = await completedCrawl(seeded);
    await addScore(seeded, first, 55);
    const second = await completedCrawl(seeded);
    await addScore(seeded, second, 68);

    const dashboard = await buildDashboard(deps, seeded.projectId);

    expect(dashboard.hasCompletedCrawl).toBe(true);
    expect(dashboard.latestScore?.composite).toBe(68);
    expect(dashboard.scoreTrend.map((point) => point.composite)).toEqual([55, 68]);
    expect(dashboard.recentPages.length).toBeGreaterThan(0);
    expect(dashboard.projectId).toBe(seeded.projectId);
  });

  it("ranks the coverage gaps the same way the coverage endpoint does", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded);
    const rival = await prisma.site.create({
      data: {
        projectId: seeded.projectId,
        url: "https://rival.com",
        domain: "rival.com",
        role: "COMPETITOR",
      },
    });
    const rivalCrawl = await prisma.crawl.create({
      data: {
        siteId: rival.id,
        projectId: seeded.projectId,
        status: "COMPLETED",
        trigger: "MANUAL",
        finishedAt: new Date(),
      },
    });

    const gap = await prisma.topic.create({
      data: { projectId: seeded.projectId, label: "Migration", source: "GENERATED", position: 0 },
    });
    const covered = await prisma.topic.create({
      data: { projectId: seeded.projectId, label: "Pricing", source: "GENERATED", position: 1 },
    });
    await prisma.topicCoverage.createMany({
      data: [
        { crawlId, topicId: gap.id, coverageScore: 5, depthChunks: 0 },
        { crawlId, topicId: covered.id, coverageScore: 80, depthChunks: 9 },
        { crawlId: rivalCrawl.id, topicId: gap.id, coverageScore: 85, depthChunks: 9 },
        { crawlId: rivalCrawl.id, topicId: covered.id, coverageScore: 70, depthChunks: 8 },
      ],
    });

    const dashboard = await buildDashboard(deps, seeded.projectId);

    expect(dashboard.topMissingTopics[0]).toMatchObject({
      label: "Migration",
      missing: true,
      gap: 80,
    });
  });
});

describe("the cache", () => {
  it("serves a hit without touching a single repository", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded);
    await addScore(seeded, crawlId, 72);
    await rebuildDashboard(deps, seeded.projectId);

    // Every repository throws; a hit must never reach one.
    const served = await readDashboard(
      { ...forbiddenRepos(), projects },
      seeded.projectId,
      seeded.userId,
    );

    if (!served.ok) throw served.error;
    expect(served.value.latestScore?.composite).toBe(72);
  });

  it("serves from cache well inside the latency budget", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded, 20);
    await addScore(seeded, crawlId, 72);
    await rebuildDashboard(deps, seeded.projectId);

    const cached = { ...forbiddenRepos(), projects };
    const timings: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = performance.now();
      const result = await readDashboard(cached, seeded.projectId, seeded.userId);
      if (!result.ok) throw result.error;
      timings.push(performance.now() - started);
    }

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95) - 1] ?? 0;
    // The budget is 200ms; a cache hit plus one ownership check should be nowhere near it.
    expect(p95).toBeLessThan(200);
  });

  it("rebuilds on a miss rather than serving an empty dashboard", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded);
    await addScore(seeded, crawlId, 64);

    // Nothing cached yet — a cold Redis must not look like a project with no data.
    const served = await readDashboard(deps, seeded.projectId, seeded.userId);

    if (!served.ok) throw served.error;
    expect(served.value.latestScore?.composite).toBe(64);
    // …and the rebuild is stored, so the next reader pays nothing.
    expect(await cache.get(dashboardKey(seeded.projectId))).not.toBeNull();
  });

  it("serves the rebuilt payload after invalidation, not the stale one", async () => {
    const seeded = await seedProject();
    const first = await completedCrawl(seeded);
    await addScore(seeded, first, 40);
    await rebuildDashboard(deps, seeded.projectId);

    const second = await completedCrawl(seeded);
    await addScore(seeded, second, 90);

    // Still stale until something invalidates or rebuilds it — that is the contract.
    const stale = await readDashboard(deps, seeded.projectId, seeded.userId);
    if (!stale.ok) throw stale.error;
    expect(stale.value.latestScore?.composite).toBe(40);

    await invalidateDashboard(deps, seeded.projectId);
    const fresh = await readDashboard(deps, seeded.projectId, seeded.userId);
    if (!fresh.ok) throw fresh.error;
    expect(fresh.value.latestScore?.composite).toBe(90);
  });

  it("treats an unreadable cache entry as a miss", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded);
    await addScore(seeded, crawlId, 51);
    // A payload written by an older deploy in a shape this build cannot parse.
    await redis.set(dashboardKey(seeded.projectId), "not json at all");

    const served = await readDashboard(deps, seeded.projectId, seeded.userId);

    if (!served.ok) throw served.error;
    expect(served.value.latestScore?.composite).toBe(51);
  });

  it("keeps one project's dashboard out of another's", async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    await addScore(mine, await completedCrawl(mine), 20);
    await addScore(theirs, await completedCrawl(theirs), 90);
    await rebuildDashboard(deps, mine.projectId);
    await rebuildDashboard(deps, theirs.projectId);

    const served = await readDashboard(deps, mine.projectId, mine.userId);
    if (!served.ok) throw served.error;
    expect(served.value.latestScore?.composite).toBe(20);
  });

  it("404s another user's project rather than serving its cached payload", async () => {
    const owner = await seedProject();
    const stranger = await seedProject();
    await rebuildDashboard(deps, owner.projectId);

    const served = await readDashboard(deps, owner.projectId, stranger.userId);

    expect(served.ok).toBe(false);
  });
});
