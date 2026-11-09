/**
 * The fan-in (M10): the aggregate is now the only thing that finalizes a crawl after a
 * successful crawl phase, so "who marked this COMPLETED?" has exactly one answer.
 *
 * What it has to get right is the difference between "the flow finished" and "everything
 * succeeded" — children that exhaust their retries are dropped from the parent's
 * dependencies rather than failing it, so the aggregate must look at what was actually
 * produced and say so.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { aggregateCrawl } from "../../../src/application/crawls/aggregate-crawl.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../../../src/infrastructure/db/repositories/events.repo.js";
import { RedisProgressStore } from "../../../src/infrastructure/redis/progress-store.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let redis: RedisClient;
let chunks: ChunksRepo;
let crawls: CrawlsRepo;
let events: EventsRepo;
let progress: RedisProgressStore;

const log = pino({ level: "silent" });

function deps() {
  return { crawls, chunks, events, progress, log };
}

interface Seeded {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
  readonly snapshotIds: readonly string[];
}

async function seed(
  pages: number,
  options: { readonly pagesFailed?: number; readonly wordCount?: number } = {},
): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `agg-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Aggregate" } });
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
      pagesChanged: pages,
      pagesFailed: options.pagesFailed ?? 0,
    },
  });

  const snapshotIds: string[] = [];
  for (let index = 0; index < pages; index += 1) {
    const page = await prisma.page.create({
      data: {
        siteId: site.id,
        url: `https://acme.com/p${index}`,
        urlHash: `agg-${crawl.id}-${index}`,
        latestContentHash: `c${index}`,
      },
    });
    const snapshot = await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: page.id,
        contentHash: `c${index}`,
        extracted: {},
        wordCount: options.wordCount ?? 300,
        storageKey: `k${index}`,
        fetchedAt: new Date(),
      },
    });
    snapshotIds.push(snapshot.id);
  }

  return {
    projectId: project.id,
    siteId: site.id,
    crawlId: crawl.id,
    snapshotIds,
  };
}

/** Marks every page as indexed, which is what a clean run leaves behind. */
async function indexAll(seeded: Seeded): Promise<void> {
  for (const snapshotId of seeded.snapshotIds) {
    await chunks.replaceForSnapshot(seeded.crawlId, snapshotId, [
      { ordinal: 0, headingPath: null, content: "Indexed content.", tokenCount: 3 },
    ]);
  }
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  chunks = new ChunksRepo(prisma);
  crawls = new CrawlsRepo(prisma);
  events = new EventsRepo(prisma);
  progress = new RedisProgressStore(redis);
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("a clean run", () => {
  it("completes the crawl with no degradation", async () => {
    const seeded = await seed(3);
    await indexAll(seeded);
    await crawls.mergeAnalysis(seeded.crawlId, {
      taxonomy: { available: true },
      topicCoverage: { available: true },
      accessCheck: { available: true },
    });

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("COMPLETED");
    expect(result.value.degradation).toBeNull();
  });

  it("records the completion event the history feed reads", async () => {
    const seeded = await seed(2);
    await indexAll(seeded);

    await aggregateCrawl(deps(), { crawlId: seeded.crawlId, projectId: seeded.projectId });

    const event = await prisma.event.findFirstOrThrow({ where: { crawlId: seeded.crawlId } });
    expect(event.kind).toBe("crawl_completed");
  });

  it("stops the progress stream, so a watching client is released", async () => {
    const seeded = await seed(2);
    await indexAll(seeded);

    await aggregateCrawl(deps(), { crawlId: seeded.crawlId, projectId: seeded.projectId });

    const snapshot = await progress.getCrawlProgress(seeded.crawlId);
    expect(snapshot).toMatchObject({ stage: "done", status: "COMPLETED" });
  });
});

describe("the crawl-complete notification (M18)", () => {
  it("enqueues a notify job once the crawl reaches COMPLETED", async () => {
    const seeded = await seed(2);
    await indexAll(seeded);
    const enqueued: Array<{ queue: string; payload: unknown }> = [];

    const result = await aggregateCrawl(
      { ...deps(), notify: { queue: { enqueue: async (queue, payload) => void enqueued.push({ queue, payload }) } } },
      { crawlId: seeded.crawlId, projectId: seeded.projectId },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("COMPLETED");
    expect(enqueued).toEqual([
      {
        queue: "notify",
        payload: { task: "crawl-complete", payload: { projectId: seeded.projectId, crawlId: seeded.crawlId } },
      },
    ]);
  });

  it("does not enqueue a notification for a crawl that ends FAILED", async () => {
    const seeded = await seed(0);
    await prisma.crawl.update({
      where: { id: seeded.crawlId },
      data: { pagesCrawled: 0, pagesFailed: 0 },
    });
    const enqueued: Array<{ queue: string; payload: unknown }> = [];

    await aggregateCrawl(
      { ...deps(), notify: { queue: { enqueue: async (queue, payload) => void enqueued.push({ queue, payload }) } } },
      { crawlId: seeded.crawlId, projectId: seeded.projectId },
    );

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    expect(crawl.status).toBe("FAILED");
    expect(enqueued).toEqual([]);
  });
});

describe("degradation", () => {
  it("flags a component the analysis artifact reports as unavailable", async () => {
    const seeded = await seed(2);
    await indexAll(seeded);
    await crawls.mergeAnalysis(seeded.crawlId, {
      taxonomy: { available: false, reason: "generation_failed" },
      topicCoverage: { available: false, reason: "no_taxonomy" },
    });

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("COMPLETED_DEGRADED");
    expect(result.value.degradation).toMatchObject({
      taxonomy: "generation_failed",
      topicCoverage: "no_taxonomy",
    });
  });

  it("flags pages that never made it into the index", async () => {
    const seeded = await seed(4);
    // Only two of the four pages produced chunks — an index child died for the rest.
    await chunks.replaceForSnapshot(seeded.crawlId, seeded.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Indexed.", tokenCount: 2 },
    ]);
    await chunks.replaceForSnapshot(seeded.crawlId, seeded.snapshotIds[1] as string, [
      { ordinal: 0, headingPath: null, content: "Indexed.", tokenCount: 2 },
    ]);

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("COMPLETED_DEGRADED");
    expect(result.value.degradation).toMatchObject({
      indexing: { pagesIndexed: 2, pagesExpected: 4 },
    });
  });

  it("does not flag a page that had no words to index", async () => {
    const seeded = await seed(2, { wordCount: 0 });

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("COMPLETED");
  });

  it("still reaches a terminal state when everything downstream failed", async () => {
    const seeded = await seed(3);
    await crawls.mergeAnalysis(seeded.crawlId, {
      taxonomy: { available: false, reason: "generation_failed" },
      topicCoverage: { available: false, reason: "no_embeddings" },
      accessCheck: { available: false, reason: "probe_failed" },
    });

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    if (!result.ok) throw result.error;
    // A stuck ANALYZING row is the one outcome the product may not produce.
    expect(result.value.status).toBe("COMPLETED_DEGRADED");
    expect(result.value.finishedAt).not.toBeNull();
  });
});

describe("crawls that should not be finalized", () => {
  it("fails a crawl whose pages were all unreadable", async () => {
    const seeded = await seed(0);
    await prisma.crawl.update({
      where: { id: seeded.crawlId },
      data: { pagesCrawled: 0, pagesFailed: 0 },
    });

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("FAILED");
    expect(result.value.errorReason).toContain("could not read any pages");
  });

  it("leaves a canceled crawl alone", async () => {
    const seeded = await seed(2);
    await prisma.crawl.update({
      where: { id: seeded.crawlId },
      data: { status: "CANCELED", finishedAt: new Date() },
    });

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("CANCELED");
    expect(await prisma.event.count({ where: { crawlId: seeded.crawlId } })).toBe(0);
  });

  it("is idempotent — a redelivered aggregate does not rewrite history", async () => {
    const seeded = await seed(2);
    await indexAll(seeded);

    const first = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });
    if (!first.ok) throw first.error;
    const second = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });
    if (!second.ok) throw second.error;

    expect(second.value.finishedAt).toBe(first.value.finishedAt);
    expect(await prisma.event.count({ where: { crawlId: seeded.crawlId } })).toBe(1);
  });

  it("resolves to nothing when the crawl has been deleted", async () => {
    const seeded = await seed(1);
    await prisma.crawl.delete({ where: { id: seeded.crawlId } });

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: seeded.projectId,
    });

    expect(result.ok).toBe(false);
  });

  it("resolves to nothing for a crawl in another project", async () => {
    const seeded = await seed(1);
    const other = await seed(1);

    const result = await aggregateCrawl(deps(), {
      crawlId: seeded.crawlId,
      projectId: other.projectId,
    });

    expect(result.ok).toBe(false);
  });
});
