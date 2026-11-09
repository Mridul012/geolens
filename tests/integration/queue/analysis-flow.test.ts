/**
 * The analysis flow's fan-out and fan-in, against real Redis and real BullMQ (M10
 * acceptance: "killing an index child mid-flow → retry → aggregate still runs exactly
 * once").
 *
 * Ordering here is a property of the flow, not of a sleep: the aggregate parent must not
 * start until every index child *and* the analyze step between them have settled. That is
 * the one thing a unit test cannot show, so it is tested against the real queue.
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
import { jobId } from "../../../src/contracts/jobs/index.js";
import { INDEX_BATCH_SIZE } from "../../../src/config/queues.js";
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

/** Records what ran, in order, so fan-in ordering is checkable. */
interface Recorder {
  readonly order: string[];
  readonly indexCalls: string[];
  readonly analyzeCalls: string[];
  readonly aggregateCalls: string[];
}

async function until(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function seedCrawl(pages: number): Promise<{
  projectId: string;
  siteId: string;
  crawlId: string;
}> {
  const user = await prisma.user.create({
    data: { email: `flow-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Flow" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId: project.id,
      status: "ANALYZING",
      trigger: "MANUAL",
      pagesCrawled: pages,
    },
  });

  for (let index = 0; index < pages; index += 1) {
    const page = await prisma.page.create({
      data: {
        siteId: site.id,
        url: `https://acme.com/p${index}`,
        urlHash: `flow-${crawl.id}-${index}`,
        latestContentHash: `c${index}`,
      },
    });
    await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: page.id,
        contentHash: `c${index}`,
        extracted: {},
        wordCount: 200,
        storageKey: `k${index}`,
        fetchedAt: new Date(),
      },
    });
  }

  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

function newRecorder(): Recorder {
  return { order: [], indexCalls: [], analyzeCalls: [], aggregateCalls: [] };
}

/** Starts the AI-pool runtime with recording processors, optionally with a poisoned child. */
function startRuntime(
  recorder: Recorder,
  options: { readonly failFirstIndexAttempts?: number } = {},
) {
  const attempts = new Map<string, number>();
  return startWorkerRuntime({
    pool: "ai",
    connection,
    jobRuns,
    logger,
    processors: {
      index: async (payload: IndexJob) => {
        const key = payload.snapshotIds[0] as string;
        const seen = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, seen);
        if (
          options.failFirstIndexAttempts !== undefined &&
          key === recorder.indexCalls[0] &&
          seen <= options.failFirstIndexAttempts
        ) {
          throw new Error(`index child killed on attempt ${seen}`);
        }
        recorder.order.push(`index:${seen}`);
        recorder.indexCalls.push(key);
      },
      analyze: async (payload: AnalyzeJob) => {
        recorder.order.push(`analyze:${payload.task}`);
        recorder.analyzeCalls.push(payload.task);
      },
      aggregate: async (payload: AggregateJob) => {
        recorder.order.push("aggregate");
        recorder.aggregateCalls.push(payload.crawlId);
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

describe("fan-out", () => {
  it("batches pages into index children under the analysis chain and one aggregate parent", async () => {
    const seeded = await seedCrawl(INDEX_BATCH_SIZE * 2 + 3);

    const result = await startAnalysisFlow(
      { crawls, flow, log: logger },
      { ...seeded, trigger: "MANUAL" },
    );

    expect(result.pagesQueued).toBe(INDEX_BATCH_SIZE * 2 + 3);
    expect(result.indexBatches).toBe(3);

    // Every node of the tree is auditable in Postgres before any of it runs: three index
    // batches, the three analysis steps, and the fan-in.
    const rows = await prisma.jobRun.findMany({ where: { refId: seeded.crawlId } });
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.queue).sort()).toEqual([
      "aggregate",
      "analyze",
      "analyze",
      "analyze",
      "index",
      "index",
      "index",
    ]);
    expect(rows.every((row) => row.projectId === seeded.projectId)).toBe(true);
  });

  it("uses deterministic job ids, so a resubmitted flow cannot double the work", async () => {
    const seeded = await seedCrawl(2);
    await startAnalysisFlow({ crawls, flow, log: logger }, { ...seeded, trigger: "MANUAL" });

    const ids = (await prisma.jobRun.findMany({ where: { refId: seeded.crawlId } })).map(
      (row) => row.bullmqJobId,
    );
    expect(ids).toContain(jobId.aggregate(seeded.crawlId));
    expect(ids).toContain(jobId.analyze(seeded.crawlId, "topic-coverage"));
    expect(ids).toContain(jobId.analyze(seeded.crawlId, "retrievability"));
    expect(ids).toContain(jobId.index(seeded.crawlId, 0));
  });

  it("still submits the tree for a crawl that captured nothing", async () => {
    const seeded = await seedCrawl(0);

    const result = await startAnalysisFlow(
      { crawls, flow, log: logger },
      { ...seeded, trigger: "SCHEDULED" },
    );

    // No index children, but the analysis steps still run — they are what record *why*
    // there is nothing to report — and the crawl must still reach a terminal state.
    expect(result.indexBatches).toBe(0);
    const rows = await prisma.jobRun.findMany({ where: { refId: seeded.crawlId } });
    expect(rows.map((row) => row.queue).sort()).toEqual([
      "aggregate",
      "analyze",
      "analyze",
      "analyze",
    ]);
  });
});

describe("fan-in", () => {
  it("runs the aggregate exactly once, and only after every child", async () => {
    const seeded = await seedCrawl(INDEX_BATCH_SIZE * 2);
    const recorder = newRecorder();
    const runtime = startRuntime(recorder);

    try {
      await startAnalysisFlow({ crawls, flow, log: logger }, { ...seeded, trigger: "MANUAL" });
      await until(async () => recorder.aggregateCalls.length > 0);
      // Give a duplicate a chance to appear before asserting "exactly once".
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(recorder.aggregateCalls).toEqual([seeded.crawlId]);
      // Page quality runs beside the index children; coverage then retrievability follow,
      // cheap before expensive.
      expect(recorder.analyzeCalls).toEqual([
        "page-quality",
        "topic-coverage",
        "retrievability",
      ]);
      expect(recorder.indexCalls).toHaveLength(2);
      // Ordering is the point: indexing, then the analysis chain, then the fan-in.
      expect(recorder.order.at(-1)).toBe("aggregate");
      expect(recorder.order.at(-2)).toBe("analyze:retrievability");
      expect(recorder.order.at(-3)).toBe("analyze:topic-coverage");
    } finally {
      await runtime.drain();
    }
  });

  it("survives an index child killed mid-flow: it retries, then the aggregate still runs once", async () => {
    const seeded = await seedCrawl(INDEX_BATCH_SIZE * 2);
    const recorder = newRecorder();
    // The first batch to arrive dies once, as a worker being killed would look.
    recorder.indexCalls.push(
      (
        await prisma.pageSnapshot.findFirstOrThrow({
          where: { crawlId: seeded.crawlId },
          orderBy: { id: "asc" },
        })
      ).id,
    );
    const runtime = startRuntime(recorder, { failFirstIndexAttempts: 1 });

    try {
      await startAnalysisFlow({ crawls, flow, log: logger }, { ...seeded, trigger: "MANUAL" });
      await until(async () => recorder.aggregateCalls.length > 0, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The killed child came back on its second attempt…
      expect(recorder.order).toContain("index:2");
      // …and the fan-in ran once, not once per child and not twice.
      expect(recorder.aggregateCalls).toEqual([seeded.crawlId]);
      expect(recorder.order.at(-1)).toBe("aggregate");
    } finally {
      await runtime.drain();
    }
  });

  it("degrades rather than hangs when a child exhausts every retry", async () => {
    const seeded = await seedCrawl(INDEX_BATCH_SIZE);
    const recorder = newRecorder();
    recorder.indexCalls.push(
      (
        await prisma.pageSnapshot.findFirstOrThrow({
          where: { crawlId: seeded.crawlId },
          orderBy: { id: "asc" },
        })
      ).id,
    );
    // More failures than the queue's `attempts`, so the child never succeeds.
    const runtime = startRuntime(recorder, { failFirstIndexAttempts: 99 });

    try {
      await startAnalysisFlow({ crawls, flow, log: logger }, { ...seeded, trigger: "MANUAL" });

      // The parent must not wait forever on a child that is never coming back — the crawl
      // finishing degraded is the product's promise, a stuck ANALYZING row is not.
      await until(async () => recorder.aggregateCalls.length > 0, 40_000);

      expect(recorder.aggregateCalls).toEqual([seeded.crawlId]);
      const failed = await jobRuns.findByBullmqId("index", jobId.index(seeded.crawlId, 0));
      expect(failed?.status).toBe("FAILED");
    } finally {
      await runtime.drain();
    }
  });
});
