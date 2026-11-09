/**
 * The scoring engine end to end (M12 acceptance).
 *
 * Real Postgres, the real analysis artifacts the earlier stages write, and the real
 * frozen weights. What is asserted here is the set of promises the product makes about
 * its own number:
 *
 *   · a completed crawl yields a `scores` row with six components, a composite and a
 *     config version, and every component resolves to evidence;
 *   · the same inputs re-scored give an identical row (pure function);
 *   · an unchanged fixture across two crawls stays within ±3 points;
 *   · below the publication floor, no row is written at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { computeScore } from "../../../src/application/scoring/compute-score.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { SiteFactsRepo } from "../../../src/infrastructure/db/repositories/site-facts.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { SCORING_V1 } from "../../../src/config/scoring/v1.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let crawls: CrawlsRepo;
let scores: ScoresRepo;
let siteFacts: SiteFactsRepo;
let topics: TopicsRepo;
let coverage: TopicCoverageRepo;

const log = pino({ level: "silent" });

function deps() {
  return { crawls, scores, siteFacts, topics, coverage, log };
}

interface Seeded {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
}

interface PageSpec {
  readonly path: string;
  readonly wordCount?: number;
  readonly structuredData?: boolean;
  readonly canonical?: boolean;
  readonly metaDescription?: boolean;
  readonly title?: boolean;
  readonly author?: boolean;
  readonly citations?: number;
  readonly qualityScore?: number | null;
  readonly dated?: boolean;
}

const RICH_PAGES: readonly PageSpec[] = [
  { path: "/", qualityScore: 80 },
  { path: "/pricing", qualityScore: 75 },
  { path: "/security", qualityScore: 70 },
  { path: "/about", qualityScore: 60 },
  { path: "/contact", wordCount: 80, qualityScore: 55 },
  { path: "/privacy", wordCount: 300, dated: true, qualityScore: 50 },
];

async function seed(
  pages: readonly PageSpec[] = RICH_PAGES,
  artifact: Record<string, unknown> = {},
): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `score-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Scoring" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId: project.id,
      status: "ANALYZING",
      trigger: "MANUAL",
      pagesCrawled: pages.length,
      analysis: {
        accessCheck: {
          allowedShare: 100,
          llmsTxt: { present: true, valid: true, issues: [] },
          robotsTxtPresent: true,
        },
        discovery: { source: "sitemap", sitemapPresent: true },
        retrievability: { available: true, score: 60, questionsTotal: 30 },
        topicCoverage: { available: true, topicsScored: 2 },
        ...artifact,
      },
    },
  });

  for (const [index, page] of pages.entries()) {
    const row = await prisma.page.create({
      data: {
        siteId: site.id,
        url: `https://acme.com${page.path}`,
        urlHash: `score-${crawl.id}-${index}`,
        latestContentHash: `c${index}`,
      },
    });
    await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: row.id,
        contentHash: `c${index}`,
        httpStatus: 200,
        title: (page.title ?? true) ? `Page ${index}` : null,
        wordCount: page.wordCount ?? 500,
        hasStructuredData: page.structuredData ?? true,
        internalLinkCount: 10 - index,
        ...(page.dated === true ? { pageUpdatedAt: new Date() } : {}),
        ...(page.qualityScore === undefined || page.qualityScore === null
          ? {}
          : { qualityScore: page.qualityScore, quality: { depth: page.qualityScore } }),
        extracted: {
          canonical: (page.canonical ?? true) ? `https://acme.com${page.path}` : null,
          metaDescription: (page.metaDescription ?? true) ? `About ${page.path}` : null,
          signals: {
            hasAuthor: page.author ?? true,
            outboundCitationCount: page.citations ?? 3,
          },
        },
        storageKey: `k${index}`,
        fetchedAt: new Date(),
      },
    });
  }

  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

/** Two active topics, one of them decision-stage, with coverage recorded. */
async function seedCoverage(
  seeded: Seeded,
  rows: ReadonlyArray<{
    label: string;
    intent: "awareness" | "consideration" | "decision" | null;
    score: number;
  }>,
): Promise<void> {
  for (const [position, row] of rows.entries()) {
    const topic = await prisma.topic.create({
      data: {
        projectId: seeded.projectId,
        label: row.label,
        source: "GENERATED",
        buyerIntent: row.intent,
        position,
      },
    });
    await prisma.topicCoverage.create({
      data: {
        crawlId: seeded.crawlId,
        topicId: topic.id,
        coverageScore: row.score,
        depthChunks: 3,
      },
    });
  }
}

beforeAll(() => {
  prisma = createTestPrisma();
  crawls = new CrawlsRepo(prisma);
  scores = new ScoresRepo(prisma);
  siteFacts = new SiteFactsRepo(prisma);
  topics = new TopicsRepo(prisma);
  coverage = new TopicCoverageRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("a completed crawl", () => {
  it("writes one score row with six components, a composite and a config version", async () => {
    const seeded = await seed();
    await seedCoverage(seeded, [
      { label: "Pricing", intent: "decision", score: 70 },
      { label: "Awareness", intent: "awareness", score: 30 },
    ]);

    const result = await computeScore(deps(), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const score = result.value.score;
    expect(score).not.toBeNull();
    expect(score?.scoringConfigVersion).toBe(SCORING_V1.version);
    expect(score?.composite).toBeGreaterThan(0);
    expect(score?.crawlId).toBe(seeded.crawlId);

    // Five components measured; citation absent until a prompt run exists.
    expect(score?.scoreRetrievability).toBe(60);
    expect(score?.scoreTopicCoverage).not.toBeNull();
    expect(score?.scoreContentQuality).not.toBeNull();
    expect(score?.scoreTechnical).not.toBeNull();
    expect(score?.scoreTrust).not.toBeNull();
    expect(score?.scoreCitation).toBeNull();

    expect(await prisma.score.count()).toBe(1);
  });

  it("resolves every component in the drawer to a weight, a reason or evidence", async () => {
    const seeded = await seed();
    await seedCoverage(seeded, [{ label: "Pricing", intent: "decision", score: 70 }]);

    const result = await computeScore(deps(), seeded);
    if (!result.ok) throw result.error;

    const rows = result.value.components["components"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row["weight"]).toBeGreaterThan(0);
      if (row["value"] === null) {
        expect(row["reason"]).toMatch(/unavailable_yet|failed/);
      } else {
        // A present component always carries something the drawer can link to.
        expect(row["evidence"]).not.toBeNull();
        expect(row["effectiveWeight"]).toBeGreaterThan(0);
      }
    }
  });

  it("weights decision-stage topics twice, as ADR 0004 requires", async () => {
    const weighted = await seed();
    await seedCoverage(weighted, [
      { label: "Pricing", intent: "decision", score: 100 },
      { label: "Blog", intent: "awareness", score: 0 },
    ]);
    const plain = await seed();
    await seedCoverage(plain, [
      { label: "Pricing", intent: null, score: 100 },
      { label: "Blog", intent: null, score: 0 },
    ]);

    const withIntent = await computeScore(deps(), weighted);
    const withoutIntent = await computeScore(deps(), plain);
    if (!withIntent.ok || !withoutIntent.ok) throw new Error("scoring failed");

    // (100·2 + 0·1)/3 = 67 versus (100 + 0)/2 = 50.
    expect(withIntent.value.score?.scoreTopicCoverage).toBe(67);
    expect(withoutIntent.value.score?.scoreTopicCoverage).toBe(50);
  });

  it("computes technical and trust from what was actually observed", async () => {
    const seeded = await seed();
    await seedCoverage(seeded, [{ label: "Pricing", intent: null, score: 50 }]);

    const result = await computeScore(deps(), seeded);
    if (!result.ok) throw result.error;

    // Every bot allowed, valid llms.txt, a sitemap, and clean meta on every page.
    expect(result.value.score?.scoreTechnical).toBe(100);
    // Authors, citations, about, contact, https and a dated policy page.
    expect(result.value.score?.scoreTrust).toBe(100);
  });

  it("drops the technical score when the bots are blocked", async () => {
    const seeded = await seed(RICH_PAGES, {
      accessCheck: {
        allowedShare: 0,
        llmsTxt: { present: true, valid: true, issues: [] },
        robotsTxtPresent: true,
      },
    });
    await seedCoverage(seeded, [{ label: "Pricing", intent: null, score: 50 }]);

    const result = await computeScore(deps(), seeded);
    if (!result.ok) throw result.error;
    expect(result.value.score?.scoreTechnical).toBe(50);
  });
});

describe("reproducibility", () => {
  it("re-scoring the same crawl produces an identical row", async () => {
    const seeded = await seed();
    await seedCoverage(seeded, [{ label: "Pricing", intent: "decision", score: 70 }]);

    const first = await computeScore(deps(), seeded);
    const second = await computeScore(deps(), seeded);
    if (!first.ok || !second.ok) throw new Error("scoring failed");

    expect(second.value.score?.composite).toBe(first.value.score?.composite);
    expect(second.value.components).toEqual(first.value.components);
    // Re-scoring replaces its own row rather than adding a second point for one crawl.
    expect(await prisma.score.count()).toBe(1);
  });

  it("stays within ±3 points across two crawls of an unchanged fixture", async () => {
    const first = await seed();
    await seedCoverage(first, [{ label: "Pricing", intent: "decision", score: 70 }]);
    const firstScore = await computeScore(deps(), first);

    // A second crawl of an identical site: same pages, same quality, same artifacts.
    const second = await seed();
    await seedCoverage(second, [{ label: "Pricing", intent: "decision", score: 70 }]);
    const secondScore = await computeScore(deps(), second);

    if (!firstScore.ok || !secondScore.ok) throw new Error("scoring failed");
    const delta = Math.abs(
      (secondScore.value.score?.composite ?? 0) - (firstScore.value.score?.composite ?? 0),
    );
    expect(delta).toBeLessThanOrEqual(3);
  });
});

describe("the publication floor", () => {
  it("writes no row when fewer than half the components have a value", async () => {
    // No retrievability, no coverage, no page quality: only technical (0.10) and
    // trust (0.05) survive — 0.15 of the evidence.
    const seeded = await seed(
      RICH_PAGES.map((page) => ({ ...page, qualityScore: null })),
      { retrievability: { available: false, reason: "judge_unavailable" } },
    );

    const result = await computeScore(deps(), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.published).toBe(false);
    expect(result.value.score).toBeNull();
    expect(await prisma.score.count()).toBe(0);
    // The reasoning is still recorded, so the UI can say *why* it is pending.
    expect(result.value.components["totalWeight"]).toBeCloseTo(0.15, 10);
  });

  it("records a failed component as failed, and a component that never ran as not-yet", async () => {
    const seeded = await seed(RICH_PAGES, {
      retrievability: { available: false, reason: "judge_unavailable" },
    });
    await seedCoverage(seeded, [{ label: "Pricing", intent: null, score: 50 }]);

    const result = await computeScore(deps(), seeded);
    if (!result.ok) throw result.error;

    const rows = result.value.components["components"] as Array<Record<string, unknown>>;
    expect(rows.find((row) => row["component"] === "retrievability")).toMatchObject({
      value: null,
      reason: "failed",
    });
    expect(rows.find((row) => row["component"] === "citation")).toMatchObject({
      value: null,
      reason: "unavailable_yet",
    });
    expect(result.value.components["degraded"]).toBe(true);
  });
});

describe("access", () => {
  it("resolves to nothing for a crawl in another project", async () => {
    const seeded = await seed();
    const other = await seed();

    const result = await computeScore(deps(), {
      projectId: other.projectId,
      crawlId: seeded.crawlId,
    });

    expect(result.ok).toBe(false);
  });
});
