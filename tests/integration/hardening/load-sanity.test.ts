/**
 * Load sanity (M20 acceptance: "10 concurrent crawls + runs"). No staging environment
 * exists for this product yet, so this drill substitutes the closest honest local
 * equivalent: 10 independent projects' analysis flows, fanned out and fanned in
 * concurrently against real Postgres and real BullMQ — proving the queue and the database
 * hold up under genuinely concurrent multi-tenant load, not just the single-flow
 * correctness `analysis-flow.test.ts` already covers.
 *
 * A full network-crawl-per-project version of this drill against a real staging deploy is
 * the fast-follow once one exists; documented in docs/runbook.md.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { createQueueConnection } from "../../../src/infrastructure/queue/connection.js";
import { BullmqJobQueue } from "../../../src/infrastructure/queue/bullmq-job-queue.js";
import { BullmqJobFlow } from "../../../src/infrastructure/queue/bullmq-job-flow.js";
import { startWorkerRuntime } from "../../../src/infrastructure/queue/worker-runtime.js";
import { JobRunsRepo } from "../../../src/infrastructure/db/repositories/job-runs.repo.js";
import { startAnalysisFlow } from "../../../src/application/indexing/start-analysis-flow.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { AggregateJob, AnalyzeJob, IndexJob } from "../../../src/contracts/jobs/index.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let connection: RedisClient;
let jobRuns: JobRunsRepo;
let queue: BullmqJobQueue;
let flow: BullmqJobFlow;
let crawls: CrawlsRepo;

const logger = pino({ level: "silent" });
const CONCURRENT_PROJECTS = 10;
const PAGES_PER_CRAWL = 6;

async function until(predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function seedCrawl(label: number): Promise<{
  projectId: string;
  siteId: string;
  crawlId: string;
}> {
  const user = await prisma.user.create({
    data: { email: `load-${label}-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: `Load ${label}` } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: `https://acme-${label}.com`, domain: `acme-${label}.com`, role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId: project.id,
      status: "ANALYZING",
      trigger: "MANUAL",
      pagesCrawled: PAGES_PER_CRAWL,
    },
  });

  for (let index = 0; index < PAGES_PER_CRAWL; index += 1) {
    const page = await prisma.page.create({
      data: {
        siteId: site.id,
        url: `https://acme-${label}.com/p${index}`,
        urlHash: `load-${crawl.id}-${index}`,
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

  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

/** Recording processors, deliberately slightly slow — closer to a real page's work than a no-op. */
function startRuntime(completed: Set<string>) {
  return startWorkerRuntime({
    pool: "ai",
    connection,
    jobRuns,
    logger,
    processors: {
      index: async (_payload: IndexJob) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      analyze: async (_payload: AnalyzeJob) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      aggregate: async (payload: AggregateJob) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        completed.add(payload.crawlId);
      },
    },
  });
}

beforeAll(async () => {
  prisma = createTestPrisma();
  connection = createQueueConnection();
  jobRuns = new JobRunsRepo(prisma);
  queue = new BullmqJobQueue(connection, jobRuns);
  flow = new BullmqJobFlow(connection, jobRuns);
  crawls = new CrawlsRepo(prisma);
  await truncateAll(prisma);
});

afterEach(async () => {
  for (const name of ["index", "analyze", "aggregate"] as const) {
    await queue.queueFor(name).obliterate({ force: true });
  }
  await truncateAll(prisma);
});

afterAll(async () => {
  await flow.close();
  await queue.close();
  await prisma.$disconnect();
  connection.disconnect();
});

describe("10 concurrent analysis flows", () => {
  it("all fan out, fan in, and complete — no deadlock, no lost work", async () => {
    const completed = new Set<string>();
    const runtime = startRuntime(completed);

    try {
      const seeds = await Promise.all(
        Array.from({ length: CONCURRENT_PROJECTS }, (_unused, index) => seedCrawl(index)),
      );

      const started = Date.now();
      const results = await Promise.all(
        seeds.map((seeded) => startAnalysisFlow({ crawls, flow, log: logger }, { ...seeded, trigger: "MANUAL" })),
      );
      expect(results.every((result) => result.indexBatches >= 1)).toBe(true);

      await until(() => Promise.resolve(completed.size === CONCURRENT_PROJECTS));
      const elapsedMs = Date.now() - started;

      expect(completed.size).toBe(CONCURRENT_PROJECTS);
      // Every flow's full job_runs audit trail landed correctly under concurrent writes —
      // one aggregate, three analyze steps, and at least one index batch per project.
      for (const seeded of seeds) {
        const rows = await prisma.jobRun.findMany({ where: { refId: seeded.crawlId } });
        expect(rows.filter((row) => row.queue === "aggregate")).toHaveLength(1);
        expect(rows.filter((row) => row.queue === "analyze")).toHaveLength(3);
        expect(rows.every((row) => row.status === "COMPLETED")).toBe(true);
      }

      console.log(`[load-sanity] ${CONCURRENT_PROJECTS} concurrent flows completed in ${elapsedMs}ms`);
    } finally {
      await runtime.drain();
    }
  }, 45_000);
});
