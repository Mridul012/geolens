/**
 * Browser-pool contention (M17 acceptance): "report generation shares the browser pool
 * without starving an active crawl."
 *
 * `crawl` and `report` are both `pool: "browser"` (docs/Backend.md §6), but each queue is
 * its own BullMQ `Worker` with its own concurrency (config/queues.ts: crawl=2, report=1) —
 * they are independent consumers, not one shared run loop. This test proves that in the
 * shape that actually matters to a customer: a report requested while several crawls are
 * mid-flight must not sit behind that backlog waiting for a turn.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { createQueueConnection } from "../../../src/infrastructure/queue/connection.js";
import { BullmqJobQueue } from "../../../src/infrastructure/queue/bullmq-job-queue.js";
import { startWorkerRuntime } from "../../../src/infrastructure/queue/worker-runtime.js";
import { JobRunsRepo } from "../../../src/infrastructure/db/repositories/job-runs.repo.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let connection: RedisClient;
let jobRuns: JobRunsRepo;
let queue: BullmqJobQueue;

const logger = pino({ level: "silent" });

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  prisma = createTestPrisma();
  connection = createQueueConnection();
  jobRuns = new JobRunsRepo(prisma);
  queue = new BullmqJobQueue(connection, jobRuns);
  await truncateAll(prisma);
});

afterEach(async () => {
  await queue.queueFor("crawl").obliterate({ force: true });
  await queue.queueFor("report").obliterate({ force: true });
  await truncateAll(prisma);
});

afterAll(async () => {
  await queue.close();
  await prisma.$disconnect();
  connection.disconnect();
});

describe("browser pool contention", () => {
  it("finishes a report job quickly even with a backlog of slow crawl jobs ahead of it", async () => {
    const CRAWL_JOBS = 6;
    const CRAWL_DURATION_MS = 800;
    const crawlFinished: string[] = [];
    let reportStartedAt: number | null = null;
    let reportFinishedAt: number | null = null;

    const runtime = startWorkerRuntime({
      pool: "browser",
      connection,
      jobRuns,
      logger,
      processors: {
        crawl: async (_payload, context) => {
          await new Promise((resolve) => setTimeout(resolve, CRAWL_DURATION_MS));
          crawlFinished.push(context.jobId);
        },
        report: async () => {
          reportStartedAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 50));
          reportFinishedAt = Date.now();
        },
      },
    });

    try {
      // `job_runs.project_id` has a real FK, so the payload needs a project that exists —
      // the crawl/site/report ids themselves are soft refs and can stay synthetic.
      const user = await prisma.user.create({
        data: { email: `contend-${Date.now()}-${Math.random()}@example.test` },
      });
      const project = await prisma.project.create({ data: { userId: user.id, name: "Contention" } });

      const enqueuedAt = Date.now();

      // More crawl jobs than the queue's concurrency (2) can run at once — a real backlog.
      for (let index = 0; index < CRAWL_JOBS; index += 1) {
        await queue.enqueue(
          "crawl",
          {
            crawlId: randomUUID(),
            projectId: project.id,
            siteId: randomUUID(),
            trigger: "MANUAL",
          },
          { jobId: `contend-crawl-${index}` },
        );
      }
      await queue.enqueue(
        "report",
        { reportId: randomUUID(), projectId: project.id },
        { jobId: "contend-report" },
      );

      await until(() => reportFinishedAt !== null);

      const reportLatencyMs = reportFinishedAt! - enqueuedAt;
      // The report's own work only takes ~50ms. If it had queued behind even one pair of
      // crawl jobs it would take 800ms+; behind the whole backlog, seconds.
      expect(reportLatencyMs).toBeLessThan(CRAWL_DURATION_MS);
      expect(reportStartedAt).not.toBeNull();

      // The backlog is real: not every crawl job had finished when the report already had.
      expect(crawlFinished.length).toBeLessThan(CRAWL_JOBS);

      // Let the crawl backlog drain before closing, so obliterate() in afterEach is clean.
      await until(() => crawlFinished.length === CRAWL_JOBS, 15_000);
    } finally {
      await runtime.drain();
    }
  }, 20_000);
});
