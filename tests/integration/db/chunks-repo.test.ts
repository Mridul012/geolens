/**
 * The raw-SQL chunk repository against real Postgres with real pgvector and real FTS
 * (M10 acceptance; Engineering-Rules §9 — never mock the thing under test).
 *
 * Everything asserted here is invisible to Prisma: `vector(1536)` and `tsvector` are
 * `Unsupported` columns, so if these statements are wrong nothing else in the test suite
 * would notice until retrieval silently returned nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let chunks: ChunksRepo;

interface Fixture {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
  readonly snapshotIds: readonly string[];
}

/** A 1,536-dimension unit vector pointing along one axis — easy similarity to reason about. */
function axisVector(axis: number): number[] {
  const vector = new Array<number>(1_536).fill(0);
  vector[axis] = 1;
  return vector;
}

/** A unit vector between two axes, so cosine similarity to each is exactly 1/√2. */
function betweenAxes(first: number, second: number): number[] {
  const vector = new Array<number>(1_536).fill(0);
  vector[first] = Math.SQRT1_2;
  vector[second] = Math.SQRT1_2;
  return vector;
}

async function seed(pages = 2): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { email: `chunks-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Chunks" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: { siteId: site.id, projectId: project.id, status: "ANALYZING", trigger: "MANUAL" },
  });

  const snapshotIds: string[] = [];
  for (let index = 0; index < pages; index += 1) {
    const page = await prisma.page.create({
      data: {
        siteId: site.id,
        url: `https://acme.com/p${index}`,
        urlHash: `hash-${index}-${crawl.id}`,
        latestContentHash: `content-${index}`,
      },
    });
    const snapshot = await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: page.id,
        contentHash: `content-${index}`,
        extracted: {},
        wordCount: 500,
        storageKey: `k-${index}`,
        fetchedAt: new Date(),
      },
    });
    snapshotIds.push(snapshot.id);
  }

  return { projectId: project.id, siteId: site.id, crawlId: crawl.id, snapshotIds };
}

async function addTopic(
  projectId: string,
  label: string,
  embedding: readonly number[] | null,
): Promise<string> {
  const topic = await prisma.topic.create({
    data: { projectId, label, source: "GENERATED", position: 0 },
  });
  if (embedding !== null) {
    await prisma.$executeRawUnsafe(
      `UPDATE topics SET embedding = $2::vector WHERE id = $1::uuid`,
      topic.id,
      `[${embedding.join(",")}]`,
    );
  }
  return topic.id;
}

beforeAll(() => {
  prisma = createTestPrisma();
  chunks = new ChunksRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("replaceForSnapshot", () => {
  it("inserts rows and returns their ids", async () => {
    const fixture = await seed(1);
    const stored = await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: "Pricing", content: "Our plans start at ten dollars.", tokenCount: 8 },
      { ordinal: 1, headingPath: null, content: "Annual billing saves twenty percent.", tokenCount: 7 },
    ]);

    expect(stored).toHaveLength(2);
    expect(stored[0]?.ordinal).toBe(0);
    expect(stored[0]?.headingPath).toBe("Pricing");
    expect(stored[1]?.headingPath).toBeNull();
    // Ids are bigint in Postgres and must survive as strings, not as lossy numbers.
    expect(stored.every((chunk) => /^\d+$/.test(chunk.id))).toBe(true);
  });

  it("sets the FTS vector in the insert, so lexical search works before any embedding", async () => {
    const fixture = await seed(1);
    await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Enterprise pricing includes SAML provisioning.", tokenCount: 9 },
      { ordinal: 1, headingPath: null, content: "Our support team answers within one hour.", tokenCount: 9 },
    ]);

    const hits = await prisma.$queryRawUnsafe<Array<{ content: string; rank: number }>>(
      `SELECT content, ts_rank_cd(tsv, plainto_tsquery('english', $2))::float8 AS rank
       FROM chunks
       WHERE crawl_id = $1::uuid AND tsv @@ plainto_tsquery('english', $2)
       ORDER BY rank DESC`,
      fixture.crawlId,
      "enterprise pricing",
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("Enterprise pricing");
    expect(hits[0]?.rank).toBeGreaterThan(0);
  });

  it("stems through the English configuration rather than matching literally", async () => {
    const fixture = await seed(1);
    await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "We are migrating customers every week.", tokenCount: 8 },
    ]);

    const hits = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM chunks
       WHERE crawl_id = $1::uuid AND tsv @@ plainto_tsquery('english', 'migrate')`,
      fixture.crawlId,
    );
    expect(Number(hits[0]?.count ?? 0)).toBe(1);
  });

  it("leaves embeddings null until the second phase", async () => {
    const fixture = await seed(1);
    await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Anything at all.", tokenCount: 4 },
    ]);

    expect(await chunks.countForCrawl(fixture.crawlId)).toBe(1);
    expect(await chunks.countEmbeddedForCrawl(fixture.crawlId)).toBe(0);
  });

  it("is idempotent — a retried batch converges rather than duplicating", async () => {
    const fixture = await seed(1);
    const snapshot = fixture.snapshotIds[0] as string;
    const batch = [
      { ordinal: 0, headingPath: null, content: "First.", tokenCount: 2 },
      { ordinal: 1, headingPath: null, content: "Second.", tokenCount: 2 },
    ];

    await chunks.replaceForSnapshot(fixture.crawlId, snapshot, batch);
    await chunks.replaceForSnapshot(fixture.crawlId, snapshot, batch);

    expect(await chunks.countForCrawl(fixture.crawlId)).toBe(2);
  });

  it("replaces rather than merges when re-chunking yields a different count", async () => {
    const fixture = await seed(1);
    const snapshot = fixture.snapshotIds[0] as string;

    await chunks.replaceForSnapshot(fixture.crawlId, snapshot, [
      { ordinal: 0, headingPath: null, content: "One.", tokenCount: 2 },
      { ordinal: 1, headingPath: null, content: "Two.", tokenCount: 2 },
      { ordinal: 2, headingPath: null, content: "Three.", tokenCount: 2 },
    ]);
    await chunks.replaceForSnapshot(fixture.crawlId, snapshot, [
      { ordinal: 0, headingPath: null, content: "Only one now.", tokenCount: 4 },
    ]);

    const remaining = await chunks.listForSnapshot(snapshot);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.content).toBe("Only one now.");
  });

  it("binds content rather than interpolating it — quotes and semicolons are just text", async () => {
    const fixture = await seed(1);
    const hostile = `'); DROP TABLE chunks; -- "quoted" \\ backslash`;

    const stored = await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: hostile, content: hostile, tokenCount: 10 },
    ]);

    expect(stored[0]?.content).toBe(hostile);
    expect(await chunks.countForCrawl(fixture.crawlId)).toBe(1);
  });

  it("writes nothing for an empty chunk list, and clears what was there", async () => {
    const fixture = await seed(1);
    const snapshot = fixture.snapshotIds[0] as string;
    await chunks.replaceForSnapshot(fixture.crawlId, snapshot, [
      { ordinal: 0, headingPath: null, content: "Gone soon.", tokenCount: 3 },
    ]);

    expect(await chunks.replaceForSnapshot(fixture.crawlId, snapshot, [])).toEqual([]);
    expect(await chunks.countForCrawl(fixture.crawlId)).toBe(0);
  });
});

describe("setEmbeddings", () => {
  it("writes vectors that read back at full precision", async () => {
    const fixture = await seed(1);
    const stored = await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Vectorised.", tokenCount: 3 },
    ]);

    const written = await chunks.setEmbeddings([
      { id: stored[0]?.id as string, vector: axisVector(7) },
    ]);

    expect(written).toBe(1);
    expect(await chunks.countEmbeddedForCrawl(fixture.crawlId)).toBe(1);

    const [row] = await prisma.$queryRawUnsafe<Array<{ sim: number }>>(
      `SELECT (1 - (embedding <=> $2::vector))::float8 AS sim FROM chunks WHERE id = $1::bigint`,
      stored[0]?.id,
      `[${axisVector(7).join(",")}]`,
    );
    expect(row?.sim).toBeCloseTo(1, 6);
  });

  it("updates many chunks in one statement", async () => {
    const fixture = await seed(1);
    const stored = await chunks.replaceForSnapshot(
      fixture.crawlId,
      fixture.snapshotIds[0] as string,
      Array.from({ length: 25 }, (_unused, index) => ({
        ordinal: index,
        headingPath: null,
        content: `Chunk number ${index}.`,
        tokenCount: 5,
      })),
    );

    const written = await chunks.setEmbeddings(
      stored.map((chunk, index) => ({ id: chunk.id, vector: axisVector(index) })),
    );

    expect(written).toBe(25);
    expect(await chunks.countEmbeddedForCrawl(fixture.crawlId)).toBe(25);
  });

  it("does nothing for an empty batch", async () => {
    expect(await chunks.setEmbeddings([])).toBe(0);
  });
});

describe("carryForward", () => {
  it("copies an unchanged page's chunks — vectors and FTS included — into the new crawl", async () => {
    const fixture = await seed(1);
    const source = fixture.snapshotIds[0] as string;
    const stored = await chunks.replaceForSnapshot(fixture.crawlId, source, [
      { ordinal: 0, headingPath: "Pricing", content: "Plans start at ten dollars.", tokenCount: 7 },
      { ordinal: 1, headingPath: "Pricing", content: "Annual billing saves money.", tokenCount: 6 },
    ]);
    await chunks.setEmbeddings(stored.map((chunk, index) => ({ id: chunk.id, vector: axisVector(index) })));

    // A second crawl of the same site whose page did not change. The first must reach a
    // terminal state first — `one_active_crawl_per_site` is a real partial unique index.
    await prisma.crawl.update({
      where: { id: fixture.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const nextCrawl = await prisma.crawl.create({
      data: {
        siteId: fixture.siteId,
        projectId: fixture.projectId,
        status: "ANALYZING",
        trigger: "SCHEDULED",
      },
    });
    const page = await prisma.pageSnapshot.findUniqueOrThrow({ where: { id: source } });
    const target = await prisma.pageSnapshot.create({
      data: {
        crawlId: nextCrawl.id,
        pageId: page.pageId,
        contentHash: page.contentHash,
        changed: false,
        carriedForwardFromId: source,
        extracted: {},
        wordCount: 500,
        storageKey: "k-carried",
        fetchedAt: new Date(),
      },
    });

    const copied = await chunks.carryForward(nextCrawl.id, target.id, source);

    expect(copied).toBe(2);
    expect(await chunks.countForCrawl(nextCrawl.id)).toBe(2);
    expect(await chunks.countEmbeddedForCrawl(nextCrawl.id)).toBe(2);

    const carried = await chunks.listForSnapshot(target.id);
    expect(carried.map((chunk) => chunk.content)).toEqual(
      stored.map((chunk) => chunk.content),
    );
    expect(carried[0]?.headingPath).toBe("Pricing");

    // The FTS vector came along too, so the carried page is still lexically searchable.
    const [hit] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM chunks
       WHERE crawl_id = $1::uuid AND tsv @@ plainto_tsquery('english', 'annual billing')`,
      nextCrawl.id,
    );
    expect(Number(hit?.count ?? 0)).toBe(1);
  });

  it("is idempotent across retries", async () => {
    const fixture = await seed(2);
    const source = fixture.snapshotIds[0] as string;
    const target = fixture.snapshotIds[1] as string;
    await chunks.replaceForSnapshot(fixture.crawlId, source, [
      { ordinal: 0, headingPath: null, content: "Carried.", tokenCount: 2 },
    ]);

    await chunks.carryForward(fixture.crawlId, target, source);
    await chunks.carryForward(fixture.crawlId, target, source);

    expect(await chunks.listForSnapshot(target)).toHaveLength(1);
  });

  it("copies nothing when the source snapshot has no chunks", async () => {
    const fixture = await seed(2);
    const copied = await chunks.carryForward(
      fixture.crawlId,
      fixture.snapshotIds[1] as string,
      fixture.snapshotIds[0] as string,
    );
    expect(copied).toBe(0);
  });
});

describe("topicMatches", () => {
  it("reports the best similarity, the depth above threshold, and ranked evidence", async () => {
    const fixture = await seed(1);
    const snapshot = fixture.snapshotIds[0] as string;

    // Three chunks: two exactly on the topic's axis, one halfway (cos = 0.7071), one away.
    const stored = await chunks.replaceForSnapshot(fixture.crawlId, snapshot, [
      { ordinal: 0, headingPath: null, content: "Exactly on topic.", tokenCount: 4 },
      { ordinal: 1, headingPath: null, content: "Also exactly on topic.", tokenCount: 5 },
      { ordinal: 2, headingPath: null, content: "Halfway there.", tokenCount: 3 },
      { ordinal: 3, headingPath: null, content: "Somewhere else entirely.", tokenCount: 4 },
    ]);
    await chunks.setEmbeddings([
      { id: stored[0]?.id as string, vector: axisVector(0) },
      { id: stored[1]?.id as string, vector: axisVector(0) },
      { id: stored[2]?.id as string, vector: betweenAxes(0, 1) },
      { id: stored[3]?.id as string, vector: axisVector(500) },
    ]);

    const topicId = await addTopic(fixture.projectId, "Axis zero", axisVector(0));
    const [match] = await chunks.topicMatches(fixture.projectId, fixture.crawlId, 0.62, 5);

    expect(match?.topicId).toBe(topicId);
    expect(match?.maxSimilarity).toBeCloseTo(1, 5);
    // cos = 1, 1 and 0.7071 clear 0.62; the orthogonal chunk does not.
    expect(match?.depthChunks).toBe(3);
    expect(match?.evidenceChunkIds.slice(0, 2)).toEqual([stored[0]?.id, stored[1]?.id]);
    expect(match?.evidenceChunkIds).toHaveLength(4);
  });

  it("honours the evidence limit", async () => {
    const fixture = await seed(1);
    const stored = await chunks.replaceForSnapshot(
      fixture.crawlId,
      fixture.snapshotIds[0] as string,
      Array.from({ length: 9 }, (_unused, index) => ({
        ordinal: index,
        headingPath: null,
        content: `On topic ${index}.`,
        tokenCount: 4,
      })),
    );
    await chunks.setEmbeddings(stored.map((chunk) => ({ id: chunk.id, vector: axisVector(3) })));
    await addTopic(fixture.projectId, "Axis three", axisVector(3));

    const [match] = await chunks.topicMatches(fixture.projectId, fixture.crawlId, 0.62, 5);
    expect(match?.evidenceChunkIds).toHaveLength(5);
    expect(match?.depthChunks).toBe(9);
  });

  it("omits topics with no centroid — a missing embedding is not a score of zero", async () => {
    const fixture = await seed(1);
    const stored = await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Content.", tokenCount: 2 },
    ]);
    await chunks.setEmbeddings([{ id: stored[0]?.id as string, vector: axisVector(0) }]);

    await addTopic(fixture.projectId, "Embedded", axisVector(0));
    await addTopic(fixture.projectId, "Not embedded", null);

    expect(await chunks.topicMatches(fixture.projectId, fixture.crawlId, 0.62, 5)).toHaveLength(1);
  });

  it("ignores archived topics", async () => {
    const fixture = await seed(1);
    const stored = await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Content.", tokenCount: 2 },
    ]);
    await chunks.setEmbeddings([{ id: stored[0]?.id as string, vector: axisVector(0) }]);

    const archived = await addTopic(fixture.projectId, "Old topic", axisVector(0));
    await prisma.topic.update({ where: { id: archived }, data: { status: "ARCHIVED" } });

    expect(await chunks.topicMatches(fixture.projectId, fixture.crawlId, 0.62, 5)).toEqual([]);
  });

  it("ignores chunks without vectors", async () => {
    const fixture = await seed(1);
    await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Never embedded.", tokenCount: 3 },
    ]);
    await addTopic(fixture.projectId, "Axis zero", axisVector(0));

    expect(await chunks.topicMatches(fixture.projectId, fixture.crawlId, 0.62, 5)).toEqual([]);
  });

  it("is scoped to one crawl — another crawl's corpus cannot inflate coverage", async () => {
    const fixture = await seed(1);
    const other = await seed(1);

    const mine = await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Mine.", tokenCount: 2 },
    ]);
    await chunks.setEmbeddings([{ id: mine[0]?.id as string, vector: axisVector(0) }]);

    const theirs = await chunks.replaceForSnapshot(other.crawlId, other.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Theirs.", tokenCount: 2 },
    ]);
    await chunks.setEmbeddings([{ id: theirs[0]?.id as string, vector: axisVector(0) }]);

    await addTopic(fixture.projectId, "Axis zero", axisVector(0));

    const [match] = await chunks.topicMatches(fixture.projectId, fixture.crawlId, 0.62, 5);
    expect(match?.depthChunks).toBe(1);
  });
});

describe("hybrid retrieval (M11)", () => {
  /** Four chunks: two about pricing, one about security, one about neither. */
  async function seedCorpus() {
    const fixture = await seed(1);
    const stored = await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      {
        ordinal: 0,
        headingPath: "Pricing",
        content: "The Growth plan costs fifty dollars per month and includes unlimited seats.",
        tokenCount: 14,
      },
      {
        ordinal: 1,
        headingPath: "Pricing > Enterprise",
        content: "Enterprise pricing is negotiated per seat with volume discounts.",
        tokenCount: 11,
      },
      {
        ordinal: 2,
        headingPath: "Security",
        content: "All customer data is encrypted at rest with AES-256.",
        tokenCount: 10,
      },
      {
        ordinal: 3,
        headingPath: null,
        content: "Our office is above a bakery in Lisbon.",
        tokenCount: 9,
      },
    ]);

    // Axis 0 is "pricing", axis 1 is "security"; the last chunk sits on its own axis.
    await chunks.setEmbeddings([
      { id: stored[0]?.id as string, vector: axisVector(0) },
      { id: stored[1]?.id as string, vector: axisVector(0) },
      { id: stored[2]?.id as string, vector: axisVector(1) },
      { id: stored[3]?.id as string, vector: axisVector(900) },
    ]);

    return { fixture, stored };
  }

  it("ranks the vector arm by cosine, best first", async () => {
    const { fixture, stored } = await seedCorpus();

    const hits = await chunks.searchByVector(fixture.crawlId, axisVector(0), 20);

    expect(hits.map((hit) => hit.id).slice(0, 2).sort()).toEqual(
      [stored[0]?.id, stored[1]?.id].sort(),
    );
    expect(hits[0]?.score).toBeCloseTo(1, 6);
    expect(hits.at(-1)?.score).toBeCloseTo(0, 6);
  });

  it("honours the vector arm's limit", async () => {
    const { fixture } = await seedCorpus();
    expect(await chunks.searchByVector(fixture.crawlId, axisVector(0), 2)).toHaveLength(2);
  });

  it("ranks the lexical arm by ts_rank_cd and returns only real matches", async () => {
    const { fixture, stored } = await seedCorpus();

    const hits = await chunks.searchByText(fixture.crawlId, "enterprise pricing per seat", 20);

    expect(hits[0]?.id).toBe(stored[1]?.id);
    expect(hits[0]?.score).toBeGreaterThan(0);
    // The bakery chunk shares no stem with the query and must not appear at all.
    expect(hits.map((hit) => hit.id)).not.toContain(stored[3]?.id);
  });

  it("matches on any query term, not all of them", async () => {
    // The documented deviation: `plainto_tsquery` ANDs, so a real buyer question would
    // match nothing and the lexical arm would be dead weight. See searchByText.
    const { fixture, stored } = await seedCorpus();

    const hits = await chunks.searchByText(
      fixture.crawlId,
      "What's the Enterprise plan's cost -- per seat, exactly?",
      20,
    );

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.id)).toContain(stored[1]?.id);
  });

  it("ranks a chunk covering more of the question above one covering less", async () => {
    const { fixture, stored } = await seedCorpus();

    // Chunk 1 has enterprise + pricing + seat; chunk 0 has plan + cost + month.
    const hits = await chunks.searchByText(fixture.crawlId, "enterprise seat pricing", 20);

    expect(hits[0]?.id).toBe(stored[1]?.id);
    expect((hits[0]?.score ?? 0)).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("survives punctuation that to_tsquery would reject outright", async () => {
    const { fixture } = await seedCorpus();
    await expect(
      chunks.searchByText(fixture.crawlId, "cost & seat | plan ! (enterprise)", 20),
    ).resolves.toBeDefined();
  });

  it("returns nothing rather than throwing when a question stems to nothing", async () => {
    const { fixture } = await seedCorpus();
    expect(await chunks.searchByText(fixture.crawlId, "the and of", 20)).toEqual([]);
    expect(await chunks.searchByText(fixture.crawlId, "???", 20)).toEqual([]);
  });

  it("scopes both arms to one crawl", async () => {
    const { fixture } = await seedCorpus();
    const other = await seed(1);
    const theirs = await chunks.replaceForSnapshot(other.crawlId, other.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Enterprise pricing elsewhere.", tokenCount: 5 },
    ]);
    await chunks.setEmbeddings([{ id: theirs[0]?.id as string, vector: axisVector(0) }]);

    const byVector = await chunks.searchByVector(fixture.crawlId, axisVector(0), 20);
    const byText = await chunks.searchByText(fixture.crawlId, "enterprise pricing", 20);

    expect(byVector.map((hit) => hit.id)).not.toContain(theirs[0]?.id);
    expect(byText.map((hit) => hit.id)).not.toContain(theirs[0]?.id);
  });

  it("hydrates fused ids into quotable context, in the order asked for", async () => {
    const { stored } = await seedCorpus();
    const order = [stored[2]?.id as string, stored[0]?.id as string];

    const context = await chunks.loadContext(order);

    expect(context.map((chunk) => chunk.id)).toEqual(order);
    expect(context[0]?.headingPath).toBe("Security");
    expect(context[0]?.content).toContain("AES-256");
    // The source URL is what makes a retrieved passage citable evidence.
    expect(context[0]?.url).toMatch(/^https:\/\/acme\.com\//);
  });

  it("silently drops an id that no longer exists rather than returning a hole", async () => {
    const { stored } = await seedCorpus();
    const context = await chunks.loadContext([stored[0]?.id as string, "999999999"]);
    expect(context.map((chunk) => chunk.id)).toEqual([stored[0]?.id]);
  });

  it("loads nothing for no ids", async () => {
    expect(await chunks.loadContext([])).toEqual([]);
  });
});

describe("indexingCompleteness", () => {
  it("counts pages with prose against pages that produced chunks", async () => {
    const fixture = await seed(3);
    await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Indexed.", tokenCount: 2 },
    ]);

    expect(await chunks.indexingCompleteness(fixture.crawlId)).toEqual({ expected: 3, indexed: 1 });
  });

  it("does not count a page with no words as missing from the index", async () => {
    const fixture = await seed(1);
    await prisma.pageSnapshot.update({
      where: { id: fixture.snapshotIds[0] as string },
      data: { wordCount: 0 },
    });

    expect(await chunks.indexingCompleteness(fixture.crawlId)).toEqual({ expected: 0, indexed: 0 });
  });
});

describe("cascade behaviour", () => {
  it("deletes a crawl's chunks with the crawl", async () => {
    const fixture = await seed(1);
    await chunks.replaceForSnapshot(fixture.crawlId, fixture.snapshotIds[0] as string, [
      { ordinal: 0, headingPath: null, content: "Transient.", tokenCount: 2 },
    ]);

    await prisma.crawl.delete({ where: { id: fixture.crawlId } });

    expect(await chunks.countForCrawl(fixture.crawlId)).toBe(0);
  });
});
