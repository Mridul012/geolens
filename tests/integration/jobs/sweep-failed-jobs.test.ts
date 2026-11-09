/**
 * The failed-job sweeper (M18 acceptance): fires on an induced failure spike, stays quiet
 * otherwise, and never mistakes a tiny sample for a real trend.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import {
  sweepFailedJobs,
  type SweepFailedJobsDeps,
} from "../../../src/application/jobs/sweep-failed-jobs.js";
import { FakeMailer } from "../../../src/infrastructure/email/fake-mailer.js";
import { JobRunsRepo } from "../../../src/infrastructure/db/repositories/job-runs.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let mailer: FakeMailer;
let deps: SweepFailedJobsDeps;

const log = pino({ level: "silent" });
const now = new Date("2026-09-06T12:00:00.000Z");
const withinWindow = new Date(now.getTime() - 10 * 60 * 1000);
const outsideWindow = new Date(now.getTime() - 90 * 60 * 1000);

async function seedJobRun(status: "COMPLETED" | "FAILED", createdAt: Date): Promise<void> {
  await prisma.jobRun.create({
    data: { id: randomUUID(), kind: "CRAWL", queue: "crawl", status, createdAt },
  });
}

beforeAll(() => {
  prisma = createTestPrisma();
});

beforeEach(async () => {
  await truncateAll(prisma);
  mailer = new FakeMailer();
  deps = {
    jobRuns: new JobRunsRepo(prisma),
    mailer,
    clock: { now: () => now },
    opsAlertEmail: "ops@vryse.example",
    log,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("an induced failure spike", () => {
  it("alerts by email when the rate exceeds 5% with a real sample", async () => {
    for (let index = 0; index < 15; index += 1) await seedJobRun("COMPLETED", withinWindow);
    for (let index = 0; index < 5; index += 1) await seedJobRun("FAILED", withinWindow);

    const result = await sweepFailedJobs(deps);

    expect(result).toEqual({ total: 20, failed: 5, alerted: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toContain("25%");
  });

  it("logs the alert but sends no email when no ops address is configured", async () => {
    for (let index = 0; index < 15; index += 1) await seedJobRun("COMPLETED", withinWindow);
    for (let index = 0; index < 5; index += 1) await seedJobRun("FAILED", withinWindow);

    const result = await sweepFailedJobs({ ...deps, opsAlertEmail: null });

    expect(result.alerted).toBe(true);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("a healthy window", () => {
  it("stays quiet when nothing failed", async () => {
    for (let index = 0; index < 20; index += 1) await seedJobRun("COMPLETED", withinWindow);

    const result = await sweepFailedJobs(deps);

    expect(result).toEqual({ total: 20, failed: 0, alerted: false });
    expect(mailer.sent).toHaveLength(0);
  });

  it("does not treat a tiny sample as a trend, even at 100% failure", async () => {
    await seedJobRun("FAILED", withinWindow);

    const result = await sweepFailedJobs(deps);

    expect(result.alerted).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("ignores failures outside the sweep window", async () => {
    for (let index = 0; index < 20; index += 1) await seedJobRun("FAILED", outsideWindow);

    const result = await sweepFailedJobs(deps);

    expect(result).toEqual({ total: 0, failed: 0, alerted: false });
  });
});
