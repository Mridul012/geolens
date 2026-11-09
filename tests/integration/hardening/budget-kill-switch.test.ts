/**
 * The budget kill-switch drill (M20 acceptance, docs/Backend.md §16 — "Budget exceeded
 * mid-run: skip remaining per-page scoring, complete aggregates, flag crawl
 * degraded:budget"). A real `BudgetGuard` reading a real `ai_usage` ledger, refusing a
 * real gateway call once the crawl's spend has reached its ceiling — proving the product's
 * hard unit-economics requirement (docs/Backend.md §1) never lets a runaway crawl overspend,
 * and never crashes when it hits the wall.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { generateTaxonomy } from "../../../src/application/analysis/generate-taxonomy.js";
import { aggregateCrawl } from "../../../src/application/crawls/aggregate-crawl.js";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { loadPrompt, render } from "../../../src/infrastructure/ai/prompts/registry.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../../../src/infrastructure/db/repositories/events.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { RedisProgressStore } from "../../../src/infrastructure/redis/progress-store.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { tierConfigFor } from "../../../src/config/model-tiers.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let redis: RedisClient;
const log = pino({ level: "silent" });

interface Seeded {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
}

async function seedCrawledSite(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `budget-drill-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Budget Drill" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId: project.id,
      status: "ANALYZING",
      trigger: "MANUAL",
      pagesCrawled: 1,
      pagesChanged: 1,
    },
  });

  const page = await prisma.page.create({
    data: { siteId: site.id, url: "https://acme.com/", urlHash: "h0", latestContentHash: "c0" },
  });
  await prisma.pageSnapshot.create({
    data: {
      crawlId: crawl.id,
      pageId: page.id,
      contentHash: "c0",
      title: "Acme",
      wordCount: 500,
      internalLinkCount: 3,
      extracted: { title: "Acme", metaDescription: "Acme desc", headings: [] },
      storageKey: "k0",
      fetchedAt: new Date(),
    },
  });

  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

function taxonomyDeps(perCrawlMicros: bigint) {
  const usage = new AiUsageRepo(prisma);
  return {
    gateway: new ProviderGateway({
      config: tierConfigFor("fake"),
      adapters: { fake: new FakeAdapter() },
      usage,
      budget: new BudgetGuard(usage, { perCrawlMicros, perRunMicros: 300_000n }),
      tracer: createLoggingTracer(log),
    }),
    crawls: new CrawlsRepo(prisma),
    sites: new SitesRepo(prisma),
    topics: new TopicsRepo(prisma),
    prompt: loadPrompt,
    render,
    log,
  };
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

describe("a crawl that has already spent its budget", () => {
  it("refuses the next AI call rather than overspending, and degrades honestly", async () => {
    const seeded = await seedCrawledSite();
    // A ceiling of zero means the very first budget check already reads "spent >= limit" —
    // the kill switch trips before a single additional micro-dollar is spent.
    const result = await generateTaxonomy(taxonomyDeps(0n), seeded);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DEGRADED");
    // No taxonomy was invented from a call that never happened.
    expect(await prisma.topic.count()).toBe(0);

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    const analysis = crawl.analysis as { taxonomy?: Record<string, unknown> };
    expect(analysis.taxonomy).toMatchObject({ available: false });
  });

  it("still reaches COMPLETED_DEGRADED end to end — a crawl never ends in a blank state", async () => {
    const seeded = await seedCrawledSite();
    await generateTaxonomy(taxonomyDeps(0n), seeded);

    const progress = new RedisProgressStore(redis);
    const result = await aggregateCrawl(
      {
        crawls: new CrawlsRepo(prisma),
        chunks: new ChunksRepo(prisma),
        events: new EventsRepo(prisma),
        progress,
        log,
      },
      { crawlId: seeded.crawlId, projectId: seeded.projectId, siteId: seeded.siteId },
    );

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("COMPLETED_DEGRADED");
    expect(result.value.finishedAt).not.toBeNull();
    // Banner-consumable: the degradation reason survives to the crawl the customer reads.
    expect(result.value.degradation).toMatchObject({ taxonomy: "generation_failed" });
  });

  it("does not refuse a call for a crawl whose budget is untouched", async () => {
    const seeded = await seedCrawledSite();

    const result = await generateTaxonomy(taxonomyDeps(500_000n), seeded);

    expect(result.ok).toBe(true);
  });
});
