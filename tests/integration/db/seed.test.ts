/**
 * The seed must be safe to run repeatedly — a developer re-running it after a schema change
 * should get the same fixture, not a second copy of it (M2 acceptance).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { createTestPrisma, testDatabaseUrl, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;

function runSeed(): void {
  execFileSync("npx", ["tsx", "scripts/seed.ts"], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: "pipe",
  });
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await truncateAll(prisma);
});

afterAll(async () => {
  await truncateAll(prisma);
  await prisma.$disconnect();
});

describe("seed", () => {
  it("produces a user, project, both sites, and one completed crawl", async () => {
    runSeed();

    const project = await prisma.project.findFirstOrThrow({ include: { sites: true } });
    expect(project.name).toBe("Acme (seed)");
    expect(project.sites.map((site) => site.role).sort()).toEqual(["COMPETITOR", "OWN"]);

    const crawl = await prisma.crawl.findFirstOrThrow();
    expect(crawl.status).toBe("COMPLETED");
    expect(crawl.pagesCrawled).toBeGreaterThan(0);
    expect(await prisma.pageSnapshot.count()).toBe(crawl.pagesCrawled);
    expect(await prisma.score.count()).toBe(1);
  });

  it("is idempotent — a second run changes no row counts", async () => {
    const before = {
      users: await prisma.user.count(),
      projects: await prisma.project.count(),
      sites: await prisma.site.count(),
      crawls: await prisma.crawl.count(),
      pages: await prisma.page.count(),
      snapshots: await prisma.pageSnapshot.count(),
      scores: await prisma.score.count(),
      events: await prisma.event.count(),
    };

    runSeed();

    expect({
      users: await prisma.user.count(),
      projects: await prisma.project.count(),
      sites: await prisma.site.count(),
      crawls: await prisma.crawl.count(),
      pages: await prisma.page.count(),
      snapshots: await prisma.pageSnapshot.count(),
      scores: await prisma.score.count(),
      events: await prisma.event.count(),
    }).toEqual(before);
  });
});
