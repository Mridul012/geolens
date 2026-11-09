/**
 * Indexing and topic coverage end to end (M10 acceptance).
 *
 * Real Postgres, real pgvector, real FTS, the real gateway and the real ledger. Only the
 * embedding *model* is substituted, and two are used for two different jobs:
 *
 *   · `SubjectAdapter` fixes same-subject similarity at a stated 0.80 and everything else
 *     at 0.00, so the published thresholds (match 0.62, ramp 0.55–0.85) do real work and
 *     changing one fails a test. It is the model wherever a score is asserted.
 *   · `FakeAdapter` is the hashing embedder the whole product runs on with no API keys. It
 *     ranks correctly on real prose but is not calibrated to a real model's scale, so it
 *     proves *ordering*, never that a number cleared a threshold.
 *
 * The four acceptance criteria are asserted directly:
 *   1. changed pages produce chunks with embeddings and a tsvector;
 *   2. unchanged pages produce zero embedding calls, and the ledger proves it;
 *   3. coverage rows exist per (crawl, topic), high where the fixture has content and ~0
 *      where it does not;
 *   4. with a crawled competitor, `missing` surfaces exactly where the fixture says.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { indexPages } from "../../../src/application/indexing/index-pages.js";
import { computeTopicCoverage } from "../../../src/application/indexing/compute-topic-coverage.js";
import { readTopicCoverage } from "../../../src/application/analysis/read-coverage.js";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import type { ProviderAdapter } from "../../../src/infrastructure/ai/adapters/provider.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { tierConfigFor } from "../../../src/config/model-tiers.js";
import { COVERAGE_V1 } from "../../../src/config/scoring/coverage.v1.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";
import { SubjectAdapter } from "../../helpers/subject-adapter.js";
import {
  COMPETITOR_PAGES,
  OWN_PAGES,
  seedCrawledSite,
  seedProject,
  type SeededProject,
} from "../../helpers/content-site.js";

let prisma: PrismaClient;
let chunks: ChunksRepo;
let crawls: CrawlsRepo;
let topics: TopicsRepo;
let coverage: TopicCoverageRepo;
let usage: AiUsageRepo;

const log = pino({ level: "silent" });

/** The taxonomy the fixture is built around: three covered, two not. */
const TAXONOMY = [
  { label: "Pricing and plans", description: "What the product costs and how the plans compare." },
  {
    label: "Security and compliance",
    description: "Certifications, encryption, audits and data protection.",
  },
  {
    label: "API reference",
    description: "Endpoints, authentication, rate limits and SDKs for the REST API.",
  },
  {
    label: "Migration guides",
    description: "Migrating and importing data from another tool, step by step.",
  },
  {
    label: "Careers and hiring",
    description: "Open roles, interview process and employee benefits at the company.",
  },
] as const;

/**
 * The embedding model used wherever a *threshold* is asserted.
 *
 * `FakeAdapter` ranks correctly on real prose but its cosines are not on a real embedder's
 * scale, so it cannot demonstrate "coverage ≥ 60". This one fixes same-subject similarity
 * at 0.80 — above the 0.62 match threshold and high on the 0.55–0.85 quality ramp, where a
 * real model puts a passage about its own subject — and everything else at exactly zero.
 */
const subjectModel = (): ProviderAdapter => new SubjectAdapter();

function buildGateway(adapter: ProviderAdapter = new FakeAdapter()): ProviderGateway {
  return new ProviderGateway({
    config: tierConfigFor("fake"),
    adapters: { fake: adapter },
    usage,
    budget: new BudgetGuard(usage, { perCrawlMicros: 5_000_000n, perRunMicros: 5_000_000n }),
    tracer: createLoggingTracer(log),
  });
}

function indexDeps(adapter: ProviderAdapter = subjectModel()) {
  return { gateway: buildGateway(adapter), chunks, crawls, log };
}

function coverageDeps() {
  return { chunks, crawls, topics, coverage, log };
}

/**
 * Creates the taxonomy with centroids, the same way `generateTaxonomy` does — label and
 * description embedded together — so coverage is measured against the real thing.
 */
async function seedTaxonomy(
  projectId: string,
  adapter: ProviderAdapter = subjectModel(),
): Promise<Map<string, string>> {
  const created = await topics.replaceGenerated(
    projectId,
    TAXONOMY.map((topic, position) => ({
      label: topic.label,
      description: topic.description,
      source: "GENERATED" as const,
      position,
    })),
  );

  const embedded = await buildGateway(adapter).embed({
    inputs: TAXONOMY.map((topic) => `${topic.label}. ${topic.description}`),
    context: { purpose: "taxonomy-embedding", projectId },
  });
  if (!embedded.ok) throw new Error("fixture taxonomy failed to embed");

  const byLabel = new Map<string, string>();
  for (const [index, topic] of created.entries()) {
    await topics.setEmbedding(topic.id, embedded.value.vectors[index] as number[]);
    byLabel.set(topic.label, topic.id);
  }
  return byLabel;
}

/** Indexes every page of a crawl in one batch, as the flow would across several. */
async function indexEverything(
  seeded: { projectId: string; crawlId: string; snapshotIds: readonly string[] },
  adapter: ProviderAdapter = subjectModel(),
) {
  return indexPages(indexDeps(adapter), {
    crawlId: seeded.crawlId,
    projectId: seeded.projectId,
    snapshotIds: seeded.snapshotIds,
  });
}

async function scoreOf(crawlId: string, topicId: string): Promise<number | null> {
  const rows = await coverage.listForCrawl(crawlId);
  return rows.find((row) => row.topicId === topicId)?.coverageScore ?? null;
}

beforeAll(() => {
  prisma = createTestPrisma();
  chunks = new ChunksRepo(prisma);
  crawls = new CrawlsRepo(prisma);
  topics = new TopicsRepo(prisma);
  coverage = new TopicCoverageRepo(prisma);
  usage = new AiUsageRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("indexing changed pages", () => {
  it("writes chunks with embeddings and a searchable tsvector", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);

    const result = await indexEverything({ projectId: seeded.projectId, ...seeded.own });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pagesIndexed).toBe(OWN_PAGES.length);
    expect(result.value.pagesCarriedForward).toBe(0);
    expect(result.value.chunksWritten).toBeGreaterThan(0);
    expect(result.value.embeddingsDegraded).toBe(false);

    // Every chunk written got a vector.
    expect(await chunks.countEmbeddedForCrawl(seeded.own.crawlId)).toBe(result.value.chunksWritten);

    // …and the FTS arm works over the same rows.
    const [hit] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM chunks
       WHERE crawl_id = $1::uuid AND tsv @@ plainto_tsquery('english', 'annual billing')`,
      seeded.own.crawlId,
    );
    expect(Number(hit?.count ?? 0)).toBeGreaterThan(0);
  });

  it("carries the heading path onto the chunk, so a citation knows where it came from", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });

    const paths = await prisma.$queryRawUnsafe<Array<{ heading_path: string | null }>>(
      `SELECT DISTINCT heading_path FROM chunks WHERE crawl_id = $1::uuid`,
      seeded.own.crawlId,
    );
    const values = paths.map((row) => row.heading_path);
    expect(values).toContain("Pricing");
    expect(values).toContain("Security");
  });

  it("writes exactly one ledger row per index batch, tagged to the crawl", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });

    expect(await usage.countsByPurpose(seeded.own.crawlId)).toEqual({ indexing: 1 });
  });

  it("is idempotent — a retried batch converges instead of duplicating chunks", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const first = await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    const after = await chunks.countForCrawl(seeded.own.crawlId);

    await indexEverything({ projectId: seeded.projectId, ...seeded.own });

    expect(await chunks.countForCrawl(seeded.own.crawlId)).toBe(after);
    expect(first.ok && first.value.chunksWritten).toBe(after);
  });

  it("resolves to nothing when the snapshots have been deleted", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await prisma.crawl.delete({ where: { id: seeded.own.crawlId } });

    const result = await indexEverything({ projectId: seeded.projectId, ...seeded.own });

    expect(result.ok).toBe(false);
  });

  it("stores chunks without vectors when embedding fails, and says so", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const noEmbeddings: ProviderAdapter = {
      name: "fake",
      complete: (request) => new FakeAdapter().complete(request),
      embed: async () => {
        throw new Error("embedding provider down");
      },
    };

    const result = await indexEverything({ projectId: seeded.projectId, ...seeded.own }, noEmbeddings);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingsDegraded).toBe(true);
    expect(result.value.chunksWritten).toBeGreaterThan(0);
    expect(result.value.embeddingsStored).toBe(0);
    // Lexical retrieval still works, which is the point of the two-phase write.
    expect(await chunks.countForCrawl(seeded.own.crawlId)).toBe(result.value.chunksWritten);
    expect(await chunks.countEmbeddedForCrawl(seeded.own.crawlId)).toBe(0);
  });
});

describe("unchanged pages", () => {
  /** A second crawl of the same site in which nothing changed. */
  async function recrawlUnchanged(seeded: SeededProject) {
    await prisma.crawl.update({
      where: { id: seeded.own.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const next = await prisma.crawl.create({
      data: {
        siteId: seeded.own.siteId,
        projectId: seeded.projectId,
        status: "ANALYZING",
        trigger: "SCHEDULED",
        pagesCrawled: seeded.own.snapshotIds.length,
      },
    });

    const snapshotIds: string[] = [];
    for (const previousId of seeded.own.snapshotIds) {
      const previous = await prisma.pageSnapshot.findUniqueOrThrow({ where: { id: previousId } });
      const snapshot = await prisma.pageSnapshot.create({
        data: {
          crawlId: next.id,
          pageId: previous.pageId,
          contentHash: previous.contentHash,
          changed: false,
          carriedForwardFromId: previous.id,
          title: previous.title,
          wordCount: previous.wordCount,
          extracted: previous.extracted ?? {},
          storageKey: `${previous.storageKey}-2`,
          fetchedAt: new Date(),
        },
      });
      snapshotIds.push(snapshot.id);
    }
    return { crawlId: next.id, snapshotIds };
  }

  it("costs zero embedding calls, and the ledger proves it", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    const next = await recrawlUnchanged(seeded);

    const result = await indexPages(indexDeps(), {
      crawlId: next.crawlId,
      projectId: seeded.projectId,
      snapshotIds: next.snapshotIds,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pagesIndexed).toBe(0);
    expect(result.value.pagesCarriedForward).toBe(OWN_PAGES.length);
    expect(result.value.embeddingsStored).toBe(0);

    // The ledger is the proof: not one row of embedding spend against the second crawl.
    expect(await usage.countsByPurpose(next.crawlId)).toEqual({});
    expect(await usage.totalForCrawl(next.crawlId)).toBe(0n);
  });

  it("still leaves the new crawl with a complete, embedded corpus", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const first = await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    const next = await recrawlUnchanged(seeded);

    await indexPages(indexDeps(), {
      crawlId: next.crawlId,
      projectId: seeded.projectId,
      snapshotIds: next.snapshotIds,
    });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await chunks.countForCrawl(next.crawlId)).toBe(first.value.chunksWritten);
    expect(await chunks.countEmbeddedForCrawl(next.crawlId)).toBe(first.value.chunksWritten);
  });

  it("scores the carried-forward crawl the same as the one it copied from", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const labels = await seedTaxonomy(seeded.projectId);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    const next = await recrawlUnchanged(seeded);
    await indexPages(indexDeps(), {
      crawlId: next.crawlId,
      projectId: seeded.projectId,
      snapshotIds: next.snapshotIds,
    });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: next.crawlId,
    });

    const pricing = labels.get("Pricing and plans") as string;
    expect(await scoreOf(next.crawlId, pricing)).toBe(await scoreOf(seeded.own.crawlId, pricing));
  });
});

describe("topic coverage", () => {
  it("writes one row per active topic and scores covered topics high, absent ones at zero", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const labels = await seedTaxonomy(seeded.projectId);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });

    const result = await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topicsScored).toBe(TAXONOMY.length);

    const rows = await coverage.listForCrawl(seeded.own.crawlId);
    expect(rows).toHaveLength(TAXONOMY.length);

    for (const covered of ["Pricing and plans", "Security and compliance", "API reference"]) {
      const score = await scoreOf(seeded.own.crawlId, labels.get(covered) as string);
      expect(score, covered).toBeGreaterThanOrEqual(COVERAGE_V1.competitorStrongAtLeast);
    }

    for (const absent of ["Migration guides", "Careers and hiring"]) {
      const score = await scoreOf(seeded.own.crawlId, labels.get(absent) as string);
      expect(score, absent).toBeLessThanOrEqual(COVERAGE_V1.ownAbsentAtMost);
    }
  });

  it("stores the evidence chunks and the thresholds version behind each score", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const labels = await seedTaxonomy(seeded.projectId);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    const rows = await coverage.listForCrawl(seeded.own.crawlId);
    const pricing = rows.find((row) => row.topicId === labels.get("Pricing and plans"));
    const evidence = pricing?.evidence as {
      chunkIds?: string[];
      maxSimilarity?: number;
      thresholdsVersion?: string;
    };

    expect(evidence.thresholdsVersion).toBe("coverage.v1");
    expect(evidence.chunkIds?.length).toBeGreaterThan(0);
    expect(evidence.chunkIds?.length).toBeLessThanOrEqual(COVERAGE_V1.evidenceChunks);
    expect(evidence.maxSimilarity).toBeGreaterThan(COVERAGE_V1.matchThreshold);

    // The evidence really points at chunks of this crawl.
    const [found] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM chunks
       WHERE crawl_id = $1::uuid AND id = ANY($2::bigint[])`,
      seeded.own.crawlId,
      evidence.chunkIds ?? [],
    );
    expect(Number(found?.count ?? 0)).toBe(evidence.chunkIds?.length);
  });

  it("records the coverage block in the crawl's analysis artifact", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await seedTaxonomy(seeded.projectId);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    expect((crawl.analysis as { topicCoverage?: unknown }).topicCoverage).toMatchObject({
      available: true,
      topicsScored: TAXONOMY.length,
      thresholdsVersion: "coverage.v1",
    });
  });

  it("costs nothing — it is arithmetic over stored vectors, not a model call", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await seedTaxonomy(seeded.projectId);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    const before = await usage.totalForCrawl(seeded.own.crawlId);

    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    expect(await usage.totalForCrawl(seeded.own.crawlId)).toBe(before);
  });

  it("is idempotent, and drops rows for topics archived between runs", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const labels = await seedTaxonomy(seeded.projectId);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    await topics.update(labels.get("Careers and hiring") as string, { status: "ARCHIVED" });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    const rows = await coverage.listForCrawl(seeded.own.crawlId);
    expect(rows).toHaveLength(TAXONOMY.length - 1);
    expect(rows.map((row) => row.topicId)).not.toContain(labels.get("Careers and hiring"));
  });

  it("reports unavailable rather than zero when the project has no taxonomy", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });

    const result = await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    expect(result.ok).toBe(false);
    expect(await coverage.listForCrawl(seeded.own.crawlId)).toEqual([]);
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    expect((crawl.analysis as { topicCoverage?: unknown }).topicCoverage).toEqual({
      available: false,
      reason: "no_taxonomy",
    });
  });

  it("reports unavailable rather than zero when the corpus has no vectors", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await seedTaxonomy(seeded.projectId);
    const noEmbeddings: ProviderAdapter = {
      name: "fake",
      complete: (request) => new FakeAdapter().complete(request),
      embed: async () => {
        throw new Error("embedding provider down");
      },
    };
    await indexEverything({ projectId: seeded.projectId, ...seeded.own }, noEmbeddings);

    const result = await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });

    expect(result.ok).toBe(false);
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    expect((crawl.analysis as { topicCoverage?: unknown }).topicCoverage).toEqual({
      available: false,
      reason: "no_embeddings",
    });
  });
});

describe("the shipped fake embedder", () => {
  it("ranks real prose onto the right topic, which is what makes the keyless build usable", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const labels = await seedTaxonomy(seeded.projectId, new FakeAdapter());
    await indexEverything({ projectId: seeded.projectId, ...seeded.own }, new FakeAdapter());

    const matches = await chunks.topicMatches(
      seeded.projectId,
      seeded.own.crawlId,
      // Ranking, not calibration: the floor is nominal, and only the ordering is asserted.
      0,
      1,
    );
    const byTopic = new Map(matches.map((match) => [match.topicId, match.maxSimilarity]));

    const pricing = byTopic.get(labels.get("Pricing and plans") as string) ?? 0;
    const careers = byTopic.get(labels.get("Careers and hiring") as string) ?? 0;
    const migration = byTopic.get(labels.get("Migration guides") as string) ?? 0;

    // Topics the fixture covers rank far above topics it does not mention at all.
    expect(pricing).toBeGreaterThan(0.5);
    expect(careers).toBeLessThan(0.1);
    expect(migration).toBeLessThan(pricing / 2);
  });
});

describe("competitor gaps", () => {
  async function seedBothSides() {
    const seeded = await seedProject(prisma, OWN_PAGES);
    const labels = await seedTaxonomy(seeded.projectId);

    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });
    await prisma.crawl.update({
      where: { id: seeded.own.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const rival = await seedCrawledSite(prisma, {
      projectId: seeded.projectId,
      domain: "rival.com",
      role: "COMPETITOR",
      pages: COMPETITOR_PAGES,
    });
    await indexPages(indexDeps(), {
      crawlId: rival.crawlId,
      projectId: seeded.projectId,
      snapshotIds: rival.snapshotIds,
    });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: rival.crawlId,
    });
    await prisma.crawl.update({
      where: { id: rival.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    return { seeded, rival, labels };
  }

  it("surfaces the migration gap and nothing else", async () => {
    const { seeded, rival, labels } = await seedBothSides();

    const result = await readTopicCoverage(
      {
        projects: new ProjectsRepo(prisma),
        sites: new SitesRepo(prisma),
        crawls,
        topics,
        coverage,
      },
      seeded.projectId,
      seeded.userId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownCrawlId).toBe(seeded.own.crawlId);
    expect(result.value.competitorCrawlId).toBe(rival.crawlId);

    const missing = result.value.data.filter((row) => row.missing);
    expect(missing.map((row) => row.label)).toEqual(["Migration guides"]);
    // The gap leads the list, which is what the UI renders first.
    expect(result.value.data[0]?.topicId).toBe(labels.get("Migration guides"));
    expect(result.value.data[0]?.gap).toBeGreaterThan(0);
  });

  it("does not call pricing a gap just because the competitor also covers it", async () => {
    const { seeded } = await seedBothSides();

    const result = await readTopicCoverage(
      {
        projects: new ProjectsRepo(prisma),
        sites: new SitesRepo(prisma),
        crawls,
        topics,
        coverage,
      },
      seeded.projectId,
      seeded.userId,
    );

    if (!result.ok) throw result.error;
    const pricing = result.value.data.find((row) => row.label === "Pricing and plans");
    expect(pricing?.missing).toBe(false);
    expect(pricing?.ownCoverage).toBeGreaterThanOrEqual(COVERAGE_V1.competitorStrongAtLeast);
  });

  it("leaves competitor columns null until the competitor has a crawl", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES);
    await seedTaxonomy(seeded.projectId);
    await indexEverything({ projectId: seeded.projectId, ...seeded.own });
    await computeTopicCoverage(coverageDeps(), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
    });
    await prisma.crawl.update({
      where: { id: seeded.own.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    await prisma.site.create({
      data: {
        projectId: seeded.projectId,
        url: "https://uncrawled.com",
        domain: "uncrawled.com",
        role: "COMPETITOR",
      },
    });

    const result = await readTopicCoverage(
      {
        projects: new ProjectsRepo(prisma),
        sites: new SitesRepo(prisma),
        crawls,
        topics,
        coverage,
      },
      seeded.projectId,
      seeded.userId,
    );

    if (!result.ok) throw result.error;
    expect(result.value.competitorCrawlId).toBeNull();
    expect(result.value.data.every((row) => row.competitorCoverage === null)).toBe(true);
    expect(result.value.data.every((row) => row.gap === null)).toBe(true);
    expect(result.value.data.some((row) => row.missing)).toBe(false);
  });
});
