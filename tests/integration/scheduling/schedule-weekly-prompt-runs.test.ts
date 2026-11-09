/**
 * The weekly prompt-run tick (M18): the prompt-sim counterpart to
 * `schedule-weekly-crawls.test.ts`, offset a few hours after the project's crawl slot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import {
  scheduleWeeklyPromptRuns,
  type ScheduleWeeklyPromptRunsDeps,
} from "../../../src/application/scheduling/schedule-weekly-prompt-runs.js";
import { PROMPT_SIM_OFFSET_HOURS } from "../../../src/config/schedule.js";
import { isDueThisHour, weeklySlotHour } from "../../../src/domain/scheduling/stagger.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { PromptRunsRepo } from "../../../src/infrastructure/db/repositories/prompt-runs.repo.js";
import { PromptTemplatesRepo } from "../../../src/infrastructure/db/repositories/prompt-templates.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { RedisProgressStore } from "../../../src/infrastructure/redis/progress-store.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let redis: RedisClient;
let deps: Omit<ScheduleWeeklyPromptRunsDeps, "clock">;

const log = pino({ level: "silent" });

function anchorInstantFor(projectId: string): Date {
  const slot = weeklySlotHour(projectId);
  const dayOfWeek = Math.floor(slot / 24);
  const hourOfDay = slot % 24;
  return new Date(Date.UTC(2026, 7, 30 + dayOfWeek, hourOfDay, 0, 0));
}

function dueInstantFor(projectId: string): Date {
  return new Date(
    anchorInstantFor(projectId).getTime() + PROMPT_SIM_OFFSET_HOURS * 60 * 60 * 1000,
  );
}

async function seedProProjectWithPrompts(): Promise<{ projectId: string; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `sim-sched-${Date.now()}-${Math.random()}@example.test` },
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
    data: { userId: user.id, name: "Scheduled Runs", timezone: "UTC" },
  });
  await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  await prisma.promptTemplate.create({
    data: {
      projectId: project.id,
      text: "best analytics tool for finance teams",
      intent: "recommendation",
      source: "GENERATED",
      position: 0,
    },
  });
  return { projectId: project.id, userId: user.id };
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  deps = {
    projects: new ProjectsRepo(prisma),
    runs: new PromptRunsRepo(prisma),
    users: new UsersRepo(prisma),
    prompts: new PromptTemplatesRepo(prisma),
    progress: new RedisProgressStore(redis),
    queue: { enqueue: async () => {} },
    log,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("scheduleWeeklyPromptRuns", () => {
  it("starts a SCHEDULED run for a due PRO project with tracked prompts", async () => {
    const seeded = await seedProProjectWithPrompts();
    const now = dueInstantFor(seeded.projectId);

    const result = await scheduleWeeklyPromptRuns({ ...deps, clock: { now: () => now } });

    expect(result).toEqual({ scheduled: 1, skipped: 0 });
    const run = await prisma.promptRun.findFirstOrThrow({ where: { projectId: seeded.projectId } });
    expect(run.trigger).toBe("SCHEDULED");
  });

  it("skips a project with no tracked prompts yet, without throwing", async () => {
    const user = await prisma.user.create({
      data: { email: `sim-empty-${Date.now()}@example.test` },
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
      data: { userId: user.id, name: "No Prompts", timezone: "UTC" },
    });
    await prisma.site.create({
      data: { projectId: project.id, url: "https://empty.com", domain: "empty.com", role: "OWN" },
    });
    const now = dueInstantFor(project.id);

    const result = await scheduleWeeklyPromptRuns({ ...deps, clock: { now: () => now } });

    expect(result).toEqual({ scheduled: 0, skipped: 1 });
  });

  it("is not due at the project's crawl slot itself — only after the offset", async () => {
    const seeded = await seedProProjectWithPrompts();
    const crawlSlotInstant = anchorInstantFor(seeded.projectId);
    expect(isDueThisHour(seeded.projectId, "UTC", crawlSlotInstant, PROMPT_SIM_OFFSET_HOURS)).toBe(
      false,
    );

    const result = await scheduleWeeklyPromptRuns({
      ...deps,
      clock: { now: () => crawlSlotInstant },
    });
    expect(result).toEqual({ scheduled: 0, skipped: 0 });
  });

  it("does not schedule twice in the same week", async () => {
    const seeded = await seedProProjectWithPrompts();
    const now = dueInstantFor(seeded.projectId);

    await scheduleWeeklyPromptRuns({ ...deps, clock: { now: () => now } });
    const second = await scheduleWeeklyPromptRuns({ ...deps, clock: { now: () => now } });

    expect(second).toEqual({ scheduled: 0, skipped: 1 });
    expect(await prisma.promptRun.count({ where: { projectId: seeded.projectId } })).toBe(1);
  });
});
