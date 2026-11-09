/**
 * The Redis-loss drill (M20 acceptance, docs/Backend.md §16 — "Redis down: web app serves
 * reads (Postgres) fine; job intake pauses with a clear 'analysis paused' state — never
 * data loss").
 *
 * This drill found a real gap: `readDashboard` called `deps.cache.get(...)` with no
 * try/catch, so an unreachable Redis (a connection error, not a cache miss) propagated as
 * an uncaught exception — a 500, not the documented "reads fine". Fixed in
 * `read-dashboard.ts` by treating a failed cache read exactly like a miss, and a failed
 * cache write after a successful rebuild as best-effort. This suite proves the fix with a
 * cache double that throws on every call, the way a dead Redis connection would.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { readDashboard, type ReadDashboardDeps } from "../../../src/application/dashboard/read-dashboard.js";
import type { Cache } from "../../../src/application/ports/cache.port.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { PromptRunsRepo } from "../../../src/infrastructure/db/repositories/prompt-runs.repo.js";
import { RecommendationsRepo } from "../../../src/infrastructure/db/repositories/recommendations.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicCoverageRepo } from "../../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { systemClock } from "../../../src/application/ports/clock.port.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let deps: ReadDashboardDeps;

/** Stands in for a dead Redis connection: every call rejects, exactly as ioredis would. */
class UnreachableCache implements Cache {
  calls = 0;
  async get<T>(): Promise<T | null> {
    this.calls += 1;
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
  async set(): Promise<void> {
    this.calls += 1;
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
  async delete(): Promise<void> {
    this.calls += 1;
    throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
  }
}

beforeAll(() => {
  prisma = createTestPrisma();
});

beforeEach(async () => {
  await truncateAll(prisma);
  deps = {
    projects: new ProjectsRepo(prisma),
    cache: new UnreachableCache(),
    clock: systemClock,
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
});

describe("Redis unreachable", () => {
  it("still serves the dashboard from Postgres rather than a 500", async () => {
    const user = await prisma.user.create({
      data: { email: `redis-loss-${Date.now()}@example.test` },
    });
    const project = await prisma.project.create({ data: { userId: user.id, name: "Acme" } });
    const site = await prisma.site.create({
      data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
    });
    const crawl = await prisma.crawl.create({
      data: {
        siteId: site.id,
        projectId: project.id,
        status: "COMPLETED",
        trigger: "MANUAL",
        finishedAt: new Date(),
      },
    });
    await new ScoresRepo(prisma).insert({
      projectId: project.id,
      crawlId: crawl.id,
      promptRunId: null,
      composite: 61,
      citation: null,
      retrievability: 60,
      contentQuality: 70,
      topicCoverage: 50,
      technical: 90,
      trust: 45,
      components: { configVersion: "scoring.v1", components: [] },
      scoringConfigVersion: "scoring.v1",
    });

    const result = await readDashboard(deps, project.id, user.id);

    if (!result.ok) throw result.error;
    expect(result.value.latestScore?.composite).toBe(61);
    expect(result.value.hasCompletedCrawl).toBe(true);
    // Both the failed read and the failed write-back were attempted and survived.
    expect((deps.cache as UnreachableCache).calls).toBeGreaterThanOrEqual(2);
  });

  it("404s an unowned project the same as when Redis is healthy — ownership never depends on the cache", async () => {
    const owner = await prisma.user.create({
      data: { email: `redis-loss-owner-${Date.now()}@example.test` },
    });
    const stranger = await prisma.user.create({
      data: { email: `redis-loss-stranger-${Date.now()}@example.test` },
    });
    const project = await prisma.project.create({ data: { userId: owner.id, name: "Acme" } });

    const result = await readDashboard(deps, project.id, stranger.id);

    expect(result.ok).toBe(false);
  });
});
