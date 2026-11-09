/**
 * The queue round-trip against real Redis and Postgres: enqueue → process → `job_runs`
 * audit row (Engineering-Rules §9 — never mock the thing under test).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { createQueueConnection } from "../../../src/infrastructure/queue/connection.js";
import {
  BullmqJobQueue,
  InvalidJobPayloadError,
} from "../../../src/infrastructure/queue/bullmq-job-queue.js";
import { startWorkerRuntime } from "../../../src/infrastructure/queue/worker-runtime.js";
import { JobRunsRepo } from "../../../src/infrastructure/db/repositories/job-runs.repo.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { JobContext } from "../../../src/application/ports/job-context.port.js";
import type { HousekeepingJob } from "../../../src/contracts/jobs/index.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let connection: RedisClient;
let jobRuns: JobRunsRepo;
let queue: BullmqJobQueue;

const logger = pino({ level: "silent" });

/** Waits for a condition rather than sleeping a fixed amount. */
async function until(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  await queue.queueFor("housekeeping").obliterate({ force: true });
  await truncateAll(prisma);
});

afterAll(async () => {
  await queue.close();
  await prisma.$disconnect();
  connection.disconnect();
});

describe("enqueue", () => {
  it("rejects a malformed payload before it ever reaches Redis", async () => {
    await expect(
      queue.enqueue(
        "housekeeping",
        { task: "purge-project", payload: { projectId: "not-a-uuid" } } as never,
        { jobId: "purge-bad" },
      ),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);

    expect(await jobRuns.findByBullmqId("housekeeping", "purge-bad")).toBeNull();
    expect(await queue.queueFor("housekeeping").getJobCountByTypes("waiting")).toBe(0);
  });

  it("writes the job_runs audit row at enqueue time", async () => {
    const projectId = "01a05108-0000-7000-8000-00000000aaaa";
    await queue.enqueue(
      "housekeeping",
      { task: "purge-project", payload: { projectId } },
      { jobId: `purge-${projectId}` },
    );

    const record = await jobRuns.findByBullmqId("housekeeping", `purge-${projectId}`);
    expect(record).toMatchObject({ kind: "CLEANUP", queue: "housekeeping", status: "QUEUED" });
    expect(record?.refId).toBe(projectId);
  });

  it("is idempotent for a repeated deterministic job id", async () => {
    const projectId = "01a05108-0000-7000-8000-00000000bbbb";
    const payload = { task: "purge-project" as const, payload: { projectId } };
    const options = { jobId: `purge-${projectId}` };

    await queue.enqueue("housekeeping", payload, options);
    await queue.enqueue("housekeeping", payload, options);

    expect(await queue.queueFor("housekeeping").getJobCountByTypes("waiting")).toBe(1);
    expect(await prisma.jobRun.count({ where: { bullmqJobId: options.jobId } })).toBe(1);
  });
});

describe("worker runtime", () => {
  it("processes a job and records the completion", async () => {
    const seen: HousekeepingJob[] = [];
    const runtime = startWorkerRuntime({
      pool: "ai",
      connection,
      jobRuns,
      logger,
      processors: {
        housekeeping: async (payload: HousekeepingJob, context: JobContext) => {
          seen.push(payload);
          await context.reportProgress({ step: "done" });
        },
      },
    });

    try {
      const projectId = "01a05108-0000-7000-8000-00000000cccc";
      await queue.enqueue(
        "housekeeping",
        { task: "purge-project", payload: { projectId } },
        { jobId: `purge-${projectId}` },
      );

      await until(async () => {
        const record = await jobRuns.findByBullmqId("housekeeping", `purge-${projectId}`);
        return record?.status === "COMPLETED";
      });

      expect(seen).toEqual([{ task: "purge-project", payload: { projectId } }]);
      const row = await prisma.jobRun.findFirstOrThrow({
        where: { bullmqJobId: `purge-${projectId}` },
      });
      expect(row.startedAt).not.toBeNull();
      expect(row.finishedAt).not.toBeNull();
      expect(row.progress).toEqual({ step: "done" });
      expect(row.error).toBeNull();
    } finally {
      await runtime.drain();
    }
  });

  it("fails a poisoned payload cleanly, with a readable reason, and retries per policy", async () => {
    let processorCalls = 0;
    const runtime = startWorkerRuntime({
      pool: "ai",
      connection,
      jobRuns,
      logger,
      processors: {
        housekeeping: async () => {
          processorCalls += 1;
        },
      },
    });

    try {
      // Bypass the enqueue-side schema check to simulate a producer running older code —
      // a queue is a deploy boundary, so the consumer must defend itself (§7).
      const poisonedId = "purge-poisoned";
      await jobRuns.recordQueued({
        kind: "CLEANUP",
        queue: "housekeeping",
        bullmqJobId: poisonedId,
      });
      await queue.queueFor("housekeeping").add(
        "housekeeping",
        { task: "purge-project", payload: { projectId: 42 } },
        { jobId: poisonedId, attempts: 2, backoff: { type: "fixed", delay: 10 } },
      );

      await until(async () => {
        const record = await jobRuns.findByBullmqId("housekeeping", poisonedId);
        return record?.status === "FAILED";
      });

      const record = await jobRuns.findByBullmqId("housekeeping", poisonedId);
      expect(record?.error).toContain("Job payload rejected");
      expect(record?.error).toContain("payload.projectId");
      // The processor was never entered — validation happened first.
      expect(processorCalls).toBe(0);
      // Retried per the job's policy rather than failing once and vanishing.
      expect(record?.attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.drain();
      // Exhaust the failed job before the next test shares this queue.
      await queue.queueFor("housekeeping").obliterate({ force: true });
    }
  });

  it("drains in-flight work on shutdown instead of dropping it", async () => {
    const projectId = "01a05108-0000-7000-8000-00000000dddd";
    const targetJobId = `purge-${projectId}`;

    // Tracked per job id, not as a shared flag: a retry left over from an earlier test
    // runs on this same queue, and a bare boolean would let it stand in for our job.
    const started = new Set<string>();
    const finished = new Set<string>();

    const runtime = startWorkerRuntime({
      pool: "ai",
      connection,
      jobRuns,
      logger,
      processors: {
        housekeeping: async (_payload: HousekeepingJob, context: JobContext) => {
          started.add(context.jobId);
          await new Promise((resolve) => setTimeout(resolve, 400));
          finished.add(context.jobId);
        },
      },
    });

    await queue.enqueue(
      "housekeeping",
      { task: "purge-project", payload: { projectId } },
      { jobId: targetJobId },
    );

    await until(async () => started.has(targetJobId), 10_000);
    await runtime.drain();

    // Drain waited for the job that was in flight rather than dropping it.
    expect(finished.has(targetJobId)).toBe(true);
    expect(runtime.isDraining()).toBe(true);
    const record = await jobRuns.findByBullmqId("housekeeping", targetJobId);
    expect(record?.status).toBe("COMPLETED");
  });

  it("tells a running job that shutdown has begun", async () => {
    let sawStopSignal = false;
    const runtime = startWorkerRuntime({
      pool: "ai",
      connection,
      jobRuns,
      logger,
      processors: {
        housekeeping: async (_payload: HousekeepingJob, context: JobContext) => {
          for (let i = 0; i < 40; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (context.shouldStop()) {
              sawStopSignal = true;
              return;
            }
          }
        },
      },
    });

    await queue.enqueue("housekeeping", { task: "sweep-deleted-projects" }, { jobId: "sweep-x" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await runtime.drain();

    expect(sawStopSignal).toBe(true);
  });
});
