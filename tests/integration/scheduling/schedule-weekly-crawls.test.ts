/**
 * The weekly-crawl tick (M18 acceptance): a scheduled crawl skips cleanly when one is
 * already active, and a SCHEDULED trigger is recorded when it isn't. The tick calls the
 * exact same `startCrawl` use case an on-demand click does — this suite proves the tick's
 * own logic (due-ness, the once-a-week guard, error-as-skip), not `startCrawl` itself.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  scheduleWeeklyCrawls,
  type ScheduleWeeklyCrawlsDeps,
} from "../../../src/application/scheduling/schedule-weekly-crawls.js";
import { weeklySlotHour } from "../../../src/domain/scheduling/stagger.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { RedisProgressStore } from "../../../src/infrastructure/redis/progress-store.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { pino } from "pino";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let redis: RedisClient;
let deps: Omit<ScheduleWeeklyCrawlsDeps, "clock">;
let enqueued: Array<{ queue: string; payload: unknown }>;

const log = pino({ level: "silent" });

/** The exact UTC instant that lands on `projectId`'s weekly slot in the UTC timezone. */
function dueInstantFor(projectId: string): Date {
  const slot = weeklySlotHour(projectId);
  const dayOfWeek = Math.floor(slot / 24);
  const hourOfDay = slot % 24;
  // 2026-08-30 is a Sunday — hour-of-week 0 at 00:00 UTC.
  return new Date(Date.UTC(2026, 7, 30 + dayOfWeek, hourOfDay, 0, 0));
}

async function seedProProject(): Promise<{ projectId: string; userId: string; siteId: string }> {
  const user = await prisma.user.create({
    data: { email: `sched-${Date.now()}-${Math.random()}@example.test` },
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
    data: { userId: user.id, name: "Scheduled", timezone: "UTC" },
  });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  return { projectId: project.id, userId: user.id, siteId: site.id };
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  enqueued = [];
  deps = {
    projects: new ProjectsRepo(prisma),
    sites: new SitesRepo(prisma),
    crawls: new CrawlsRepo(prisma),
    users: new UsersRepo(prisma),
    progress: new RedisProgressStore(redis),
    queue: {
      enqueue: async (queue, payload) => {
        enqueued.push({ queue, payload });
      },
    },
    log,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
  enqueued = [];
});

describe("scheduleWeeklyCrawls", () => {
  it("starts a SCHEDULED crawl for a due PRO project with nothing running", async () => {
    const seeded = await seedProProject();
    const now = dueInstantFor(seeded.projectId);

    const result = await scheduleWeeklyCrawls({ ...deps, clock: { now: () => now } });

    expect(result).toEqual({ scheduled: 1, skipped: 0 });
    const crawl = await prisma.crawl.findFirstOrThrow({ where: { projectId: seeded.projectId } });
    expect(crawl.trigger).toBe("SCHEDULED");
    expect(crawl.status).toBe("QUEUED");
    expect(enqueued.some((job) => job.queue === "crawl")).toBe(true);
  });

  it("skips cleanly, without throwing, when the site already has an active crawl", async () => {
    const seeded = await seedProProject();
    const now = dueInstantFor(seeded.projectId);
    await prisma.crawl.create({
      data: {
        siteId: seeded.siteId,
        projectId: seeded.projectId,
        status: "CRAWLING",
        trigger: "MANUAL",
      },
    });

    const result = await scheduleWeeklyCrawls({ ...deps, clock: { now: () => now } });

    expect(result).toEqual({ scheduled: 0, skipped: 1 });
    const crawls = await prisma.crawl.findMany({ where: { projectId: seeded.projectId } });
    expect(crawls).toHaveLength(1); // the pre-existing one only — nothing new was created
  });

  it("does not schedule a second crawl for the same project within the same week", async () => {
    const seeded = await seedProProject();
    const now = dueInstantFor(seeded.projectId);

    const first = await scheduleWeeklyCrawls({ ...deps, clock: { now: () => now } });
    expect(first.scheduled).toBe(1);

    const second = await scheduleWeeklyCrawls({ ...deps, clock: { now: () => now } });
    expect(second).toEqual({ scheduled: 0, skipped: 1 });

    const crawls = await prisma.crawl.findMany({ where: { projectId: seeded.projectId } });
    expect(crawls).toHaveLength(1);
  });

  it("ignores a project whose weekly slot is not this hour", async () => {
    const seeded = await seedProProject();
    const notDue = new Date(dueInstantFor(seeded.projectId).getTime() + 60 * 60 * 1000);

    const result = await scheduleWeeklyCrawls({ ...deps, clock: { now: () => notDue } });

    expect(result).toEqual({ scheduled: 0, skipped: 0 });
    expect(await prisma.crawl.count({ where: { projectId: seeded.projectId } })).toBe(0);
  });

  it("ignores a FREE-plan project even when its slot is due", async () => {
    const user = await prisma.user.create({
      data: { email: `free-${Date.now()}@example.test` },
    });
    const project = await prisma.project.create({
      data: { userId: user.id, name: "Free", timezone: "UTC" },
    });
    await prisma.site.create({
      data: { projectId: project.id, url: "https://free.com", domain: "free.com", role: "OWN" },
    });
    const now = dueInstantFor(project.id);

    const result = await scheduleWeeklyCrawls({ ...deps, clock: { now: () => now } });

    expect(result).toEqual({ scheduled: 0, skipped: 0 });
    expect(await prisma.crawl.count({ where: { projectId: project.id } })).toBe(0);
  });
});
