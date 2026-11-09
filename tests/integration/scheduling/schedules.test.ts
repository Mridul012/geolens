/**
 * BullMQ job-scheduler registration (M18 acceptance): idempotent across worker restarts.
 *
 * "Restart" is simulated the only way that means anything for a job scheduler: calling
 * `registerSchedules` again, exactly as every worker boot does, against schedulers that
 * already exist in Redis from a previous boot.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createQueueConnection } from "../../../src/infrastructure/queue/connection.js";
import { BullmqJobQueue } from "../../../src/infrastructure/queue/bullmq-job-queue.js";
import { registerSchedules } from "../../../src/infrastructure/queue/schedules.js";
import { SCHEDULER_IDS } from "../../../src/config/schedule.js";
import { JobRunsRepo } from "../../../src/infrastructure/db/repositories/job-runs.repo.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let connection: RedisClient;
let queue: BullmqJobQueue;

beforeAll(async () => {
  prisma = createTestPrisma();
  connection = createQueueConnection();
  queue = new BullmqJobQueue(connection, new JobRunsRepo(prisma));
  await truncateAll(prisma);
});

afterEach(async () => {
  const housekeeping = queue.queueFor("housekeeping");
  for (const scheduler of await housekeeping.getJobSchedulers()) {
    await housekeeping.removeJobScheduler(scheduler.key);
  }
  await housekeeping.obliterate({ force: true });
  await truncateAll(prisma);
});

afterAll(async () => {
  await queue.close();
  await prisma.$disconnect();
  connection.disconnect();
});

describe("registerSchedules", () => {
  it("registers exactly one scheduler per configured schedule", async () => {
    await registerSchedules(queue);

    const schedulers = await queue.queueFor("housekeeping").getJobSchedulers();
    const keys = schedulers.map((scheduler) => scheduler.key).sort();
    expect(keys).toEqual(Object.values(SCHEDULER_IDS).sort());
  });

  it("is idempotent across a simulated restart — no duplicates, same schedulers", async () => {
    await registerSchedules(queue);
    const first = await queue.queueFor("housekeeping").getJobSchedulers();

    // A second worker booting (or the same one restarting) calls this again.
    await registerSchedules(queue);
    const second = await queue.queueFor("housekeeping").getJobSchedulers();

    expect(second).toHaveLength(first.length);
    expect(new Set(second.map((scheduler) => scheduler.key)).size).toBe(
      Object.keys(SCHEDULER_IDS).length,
    );
  });

  it("carries the task discriminant so the housekeeping processor can route it", async () => {
    await registerSchedules(queue);
    const scheduler = await queue
      .queueFor("housekeeping")
      .getJobScheduler(SCHEDULER_IDS.weeklyCrawls);
    expect(scheduler?.template?.data).toMatchObject({ task: "schedule-weekly-crawls" });
  });
});
