/**
 * The deletion purge (M5 acceptance): a soft-deleted project's derived rows go in batches,
 * the financial ledger survives with its references nulled, and the whole thing is safe to
 * run twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PurgeRepo } from "../../../src/infrastructure/db/repositories/purge.repo.js";
import { purgeProject } from "../../../src/application/jobs/purge-project.js";
import { sweepDeletedProjects } from "../../../src/application/jobs/sweep-deleted-projects.js";
import type { JobQueue } from "../../../src/application/ports/job-queue.port.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;

interface Seeded {
  readonly projectId: string;
  readonly crawlId: string;
  readonly snapshotCount: number;
}

/** Builds a project with enough rows that batching is actually exercised. */
async function seedProject(snapshotCount: number): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `purge-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: "Purge fixture" },
  });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.test", domain: "acme.test", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: { siteId: site.id, projectId: project.id, status: "COMPLETED", trigger: "MANUAL" },
  });

  const pages = await Promise.all(
    Array.from({ length: snapshotCount }, (_unused, index) =>
      prisma.page.create({
        data: {
          siteId: site.id,
          url: `https://acme.test/page-${index}`,
          urlHash: `hash-${index}`,
          latestContentHash: `content-${index}`,
        },
      }),
    ),
  );

  await prisma.pageSnapshot.createMany({
    data: pages.map((page, index) => ({
      crawlId: crawl.id,
      pageId: page.id,
      contentHash: `content-${index}`,
      extracted: { title: `Page ${index}` },
      storageKey: `snapshots/${project.id}/${crawl.id}/content-${index}.html.gz`,
      fetchedAt: new Date(),
    })),
  });

  const topic = await prisma.topic.create({
    data: { projectId: project.id, label: "Pricing", source: "GENERATED" },
  });
  await prisma.topicCoverage.create({
    data: { crawlId: crawl.id, topicId: topic.id, coverageScore: 40, depthChunks: 2 },
  });

  const template = await prisma.promptTemplate.create({
    data: { projectId: project.id, text: "best tool for x", source: "GENERATED" },
  });
  const run = await prisma.promptRun.create({
    data: { projectId: project.id, trigger: "MANUAL", status: "COMPLETED", engines: ["perplexity"] },
  });
  await prisma.promptResult.create({
    data: {
      promptRunId: run.id,
      promptTemplateId: template.id,
      engine: "perplexity",
      sampleIndex: 0,
      model: "sonar",
    },
  });

  await prisma.score.create({
    data: {
      projectId: project.id,
      crawlId: crawl.id,
      composite: 50,
      components: {},
      scoringConfigVersion: "v1",
    },
  });
  await prisma.recommendation.create({
    data: {
      projectId: project.id,
      fingerprint: "rule-no-llms-txt",
      source: "RULE",
      title: "Add llms.txt",
      body: "Publish one.",
      priority: "HIGH",
      impact: 3,
      difficulty: 1,
      evidence: {},
    },
  });
  await prisma.report.create({
    data: { projectId: project.id, kind: "ON_DEMAND", status: "READY", storageKey: "reports/x.pdf" },
  });
  await prisma.event.create({
    data: { projectId: project.id, kind: "crawl_completed", payload: {} },
  });
  await prisma.aiUsage.create({
    data: {
      projectId: project.id,
      crawlId: crawl.id,
      purpose: "taxonomy",
      provider: "openai",
      model: "test-model",
      costUsdMicros: 4_200n,
    },
  });
  await prisma.jobRun.create({
    data: { projectId: project.id, kind: "CRAWL", queue: "crawl", bullmqJobId: `crawl-${crawl.id}` },
  });

  return { projectId: project.id, crawlId: crawl.id, snapshotCount };
}

beforeAll(() => {
  prisma = createTestPrisma();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("purgeProject", () => {
  it("empties every child table and removes the project row", async () => {
    const seeded = await seedProject(12);
    await prisma.project.update({
      where: { id: seeded.projectId },
      data: { deletedAt: new Date() },
    });

    const result = await purgeProject({ purge: new PurgeRepo(prisma) }, seeded.projectId);

    expect(result.completed).toBe(true);
    expect(await prisma.pageSnapshot.count()).toBe(0);
    expect(await prisma.page.count()).toBe(0);
    expect(await prisma.crawl.count()).toBe(0);
    expect(await prisma.site.count()).toBe(0);
    expect(await prisma.topicCoverage.count()).toBe(0);
    expect(await prisma.topic.count()).toBe(0);
    expect(await prisma.promptResult.count()).toBe(0);
    expect(await prisma.promptRun.count()).toBe(0);
    expect(await prisma.promptTemplate.count()).toBe(0);
    expect(await prisma.score.count()).toBe(0);
    expect(await prisma.recommendation.count()).toBe(0);
    expect(await prisma.report.count()).toBe(0);
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
  });

  it("deletes in batches rather than one unbounded statement", async () => {
    const seeded = await seedProject(25);
    await prisma.project.update({
      where: { id: seeded.projectId },
      data: { deletedAt: new Date() },
    });

    const batches: Array<{ table: string; deleted: number }> = [];
    // Batch size 10 against 25 snapshots: three statements, none holding a long lock.
    await purgeProject(
      {
        purge: new PurgeRepo(prisma, { batchSize: 10 }),
        onProgress: (progress) => {
          batches.push({ table: progress.table, deleted: progress.deleted });
        },
      },
      seeded.projectId,
    );

    const snapshotBatches = batches.filter((batch) => batch.table === "page_snapshots");
    expect(snapshotBatches).toHaveLength(3);
    expect(snapshotBatches.map((batch) => batch.deleted)).toEqual([10, 10, 5]);
    expect(await prisma.pageSnapshot.count()).toBe(0);
  });

  it("keeps ai_usage as a ledger, with its references nulled", async () => {
    const seeded = await seedProject(3);
    await prisma.project.update({
      where: { id: seeded.projectId },
      data: { deletedAt: new Date() },
    });

    await purgeProject({ purge: new PurgeRepo(prisma) }, seeded.projectId);

    const ledger = await prisma.aiUsage.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.projectId).toBeNull();
    expect(ledger[0]?.costUsdMicros).toBe(4_200n);
  });

  it("keeps job_runs history after the project is gone", async () => {
    const seeded = await seedProject(2);
    await prisma.project.update({
      where: { id: seeded.projectId },
      data: { deletedAt: new Date() },
    });

    await purgeProject({ purge: new PurgeRepo(prisma) }, seeded.projectId);

    const history = await prisma.jobRun.findMany();
    expect(history).toHaveLength(1);
    expect(history[0]?.projectId).toBeNull();
    expect(history[0]?.queue).toBe("crawl");
  });

  it("is safe to run twice", async () => {
    const seeded = await seedProject(5);
    await prisma.project.update({
      where: { id: seeded.projectId },
      data: { deletedAt: new Date() },
    });

    await purgeProject({ purge: new PurgeRepo(prisma) }, seeded.projectId);
    const second = await purgeProject({ purge: new PurgeRepo(prisma) }, seeded.projectId);

    expect(second.completed).toBe(true);
    expect(second.deletedByTable.every((row) => row.deleted === 0)).toBe(true);
  });

  it("refuses to delete a project that was never soft-deleted", async () => {
    const seeded = await seedProject(2);

    await purgeProject({ purge: new PurgeRepo(prisma) }, seeded.projectId);

    // Derived rows go, but the project row itself survives — only a user-initiated
    // deletion sets `deleted_at`, and the final delete is guarded on it.
    expect(await prisma.project.count()).toBe(1);
  });

  it("stops between batches when the worker is draining", async () => {
    const seeded = await seedProject(6);
    await prisma.project.update({
      where: { id: seeded.projectId },
      data: { deletedAt: new Date() },
    });

    const result = await purgeProject(
      { purge: new PurgeRepo(prisma, { batchSize: 2 }), shouldStop: () => true },
      seeded.projectId,
    );

    expect(result.completed).toBe(false);
    // The project row survives, so the sweep re-enqueues and finishes the job later.
    expect(await prisma.project.count()).toBe(1);
  });

  it("deletes stored objects before the rows that name them", async () => {
    const seeded = await seedProject(3);
    await prisma.project.update({
      where: { id: seeded.projectId },
      data: { deletedAt: new Date() },
    });

    const deletedKeys: string[] = [];
    const result = await purgeProject(
      {
        purge: new PurgeRepo(prisma),
        storage: {
          put: async () => undefined,
          get: async () => null,
          signedUrl: async () => "https://example.test",
          deleteMany: async (keys) => {
            deletedKeys.push(...keys);
          },
        },
      },
      seeded.projectId,
    );

    expect(result.objectsDeleted).toBe(4); // three snapshots plus one report
    expect(deletedKeys.filter((key) => key.startsWith("snapshots/"))).toHaveLength(3);
    expect(deletedKeys).toContain("reports/x.pdf");
  });
});

describe("sweepDeletedProjects", () => {
  it("re-enqueues purges for projects whose enqueue was lost", async () => {
    const a = await seedProject(1);
    const b = await seedProject(1);
    await prisma.project.updateMany({
      where: { id: { in: [a.projectId, b.projectId] } },
      data: { deletedAt: new Date() },
    });

    const enqueued: Array<{ queue: string; jobId: string }> = [];
    const queue: JobQueue = {
      enqueue: async (queueName, _payload, options) => {
        enqueued.push({ queue: queueName, jobId: options.jobId });
      },
    };

    const result = await sweepDeletedProjects({
      purge: new PurgeRepo(prisma),
      queue,
      clock: { now: () => new Date() },
    });

    expect(result.enqueued).toBe(2);
    expect(enqueued.map((job) => job.jobId).sort()).toEqual(
      [`purge-${a.projectId}`, `purge-${b.projectId}`].sort(),
    );
  });

  it("ignores live projects", async () => {
    await seedProject(1);
    const enqueued: string[] = [];

    const result = await sweepDeletedProjects({
      purge: new PurgeRepo(prisma),
      queue: {
        enqueue: async (_queue, _payload, options) => {
          enqueued.push(options.jobId);
        },
      },
      clock: { now: () => new Date() },
    });

    expect(result.enqueued).toBe(0);
    expect(enqueued).toEqual([]);
  });
});
