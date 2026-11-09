/**
 * The weekly digest tick (M18): only enqueues — `send-digest.ts` decides whether an email
 * is actually worth sending. What this tick owns is due-ness and giving BullMQ a
 * deterministic jobId to dedupe on if the tick ever fires twice for the same week.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  scheduleWeeklyDigests,
  type ScheduleWeeklyDigestsDeps,
} from "../../../src/application/scheduling/schedule-weekly-digests.js";
import { DIGEST_OFFSET_HOURS } from "../../../src/config/schedule.js";
import { weeklySlotHour } from "../../../src/domain/scheduling/stagger.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let enqueued: Array<{ queue: string; payload: unknown; jobId: string }>;
let deps: Omit<ScheduleWeeklyDigestsDeps, "clock">;

function dueInstantFor(projectId: string): Date {
  const slot = (weeklySlotHour(projectId) + DIGEST_OFFSET_HOURS) % (24 * 7);
  const dayOfWeek = Math.floor(slot / 24);
  const hourOfDay = slot % 24;
  return new Date(Date.UTC(2026, 7, 30 + dayOfWeek, hourOfDay, 0, 0));
}

async function seedProProject(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `digest-sched-${Date.now()}-${Math.random()}@example.test` },
  });
  await prisma.subscription.create({
    data: {
      userId: user.id,
      stripeCustomerId: `cus_${user.id.slice(0, 8)}`,
      plan: "PRO",
      status: "ACTIVE",
    },
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: "Digest", timezone: "UTC" },
  });
  await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  return project.id;
}

beforeAll(() => {
  prisma = createTestPrisma();
});

beforeEach(async () => {
  await truncateAll(prisma);
  enqueued = [];
  deps = {
    projects: new ProjectsRepo(prisma),
    queue: {
      enqueue: async (queue, payload, options) => {
        enqueued.push({ queue, payload, jobId: options.jobId });
      },
    },
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("scheduleWeeklyDigests", () => {
  it("enqueues a notify job for a due PRO project", async () => {
    const projectId = await seedProProject();
    const now = dueInstantFor(projectId);

    const result = await scheduleWeeklyDigests({ ...deps, clock: { now: () => now } });

    expect(result).toEqual({ enqueued: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.queue).toBe("notify");
    expect(enqueued[0]?.payload).toEqual({ task: "weekly-digest", payload: { projectId } });
  });

  it("does nothing for a project not due this hour", async () => {
    const projectId = await seedProProject();
    const notDue = new Date(dueInstantFor(projectId).getTime() + 60 * 60 * 1000);

    const result = await scheduleWeeklyDigests({ ...deps, clock: { now: () => notDue } });

    expect(result).toEqual({ enqueued: 0 });
  });

  it("uses the same jobId for two ticks in the same week — BullMQ's own dedupe backstop", async () => {
    const projectId = await seedProProject();
    const now = dueInstantFor(projectId);

    await scheduleWeeklyDigests({ ...deps, clock: { now: () => now } });
    await scheduleWeeklyDigests({ ...deps, clock: { now: () => now } });

    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]?.jobId).toBe(enqueued[1]?.jobId);
  });
});
