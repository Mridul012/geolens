/**
 * The usage rollup (M18): backfills `crawls.ai_cost_usd_micros` — documented in
 * docs/Database.md §2.6 as "a rollup from ai_usage", but nothing writes it at crawl time.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { rollUpUsage } from "../../../src/application/jobs/usage-rollup.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let crawls: CrawlsRepo;
let aiUsage: AiUsageRepo;

const log = pino({ level: "silent" });

async function seedCompletedCrawl(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `rollup-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Rollup" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: { siteId: site.id, projectId: project.id, status: "COMPLETED", trigger: "MANUAL" },
  });
  return crawl.id;
}

beforeAll(() => {
  prisma = createTestPrisma();
  crawls = new CrawlsRepo(prisma);
  aiUsage = new AiUsageRepo(prisma);
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("rollUpUsage", () => {
  it("sums a crawl's ai_usage rows into ai_cost_usd_micros", async () => {
    const crawlId = await seedCompletedCrawl();
    await aiUsage.record({
      crawlId,
      purpose: "page-quality",
      provider: "fake",
      model: "fake-bulk",
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      costUsdMicros: 1_200n,
      latencyMs: 50,
    });
    await aiUsage.record({
      crawlId,
      purpose: "taxonomy",
      provider: "fake",
      model: "fake-frontier",
      inputTokens: 200,
      outputTokens: 100,
      cachedInputTokens: 0,
      costUsdMicros: 3_800n,
      latencyMs: 80,
    });

    const result = await rollUpUsage({ crawls, aiUsage, log });

    expect(result.updated).toBe(1);
    const row = await prisma.crawl.findUniqueOrThrow({ where: { id: crawlId } });
    expect(row.aiCostUsdMicros).toBe(5_000n);
  });

  it("leaves a genuinely zero-cost crawl at zero, not an error", async () => {
    await seedCompletedCrawl();

    const result = await rollUpUsage({ crawls, aiUsage, log });

    expect(result.updated).toBe(1);
  });

  it("does not touch a crawl that already has its rollup", async () => {
    const crawlId = await seedCompletedCrawl();
    await crawls.setCostRollup(crawlId, 9_999n);

    const result = await rollUpUsage({ crawls, aiUsage, log });

    expect(result.updated).toBe(0);
    const row = await prisma.crawl.findUniqueOrThrow({ where: { id: crawlId } });
    expect(row.aiCostUsdMicros).toBe(9_999n);
  });
});
