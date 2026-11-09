/**
 * The comparison read (M16 acceptance, docs/API.md §3 — Competitors).
 *
 * A real account passes through every one of these states in its first hour: no competitor
 * tracked at all, a competitor added but never crawled, both crawled but no prompt run yet,
 * and finally the full picture. None of them is an error and none of them collapses into a
 * zero — that is the entire behavioural contract this suite pins down.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { readComparison, type ReadComparisonDeps } from "../../../src/application/analysis/read-comparison.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { PromptRunsRepo } from "../../../src/infrastructure/db/repositories/prompt-runs.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { SiteFactsRepo } from "../../../src/infrastructure/db/repositories/site-facts.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicCoverageRepo } from "../../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { systemClock } from "../../../src/application/ports/clock.port.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let deps: ReadComparisonDeps;

interface Seeded {
  readonly userId: string;
  readonly projectId: string;
  readonly siteId: string;
}

async function seedProject(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `cmp-${Date.now()}-${Math.random()}@example.test` },
  });
  // Comparison is a PRO unlock (M19) — every fixture here needs the entitlement to reach
  // the behaviour under test, so the access-control tests seed FREE explicitly instead.
  await prisma.subscription.create({
    data: {
      userId: user.id,
      stripeCustomerId: `cus_${randomUUID()}`,
      plan: "PRO",
      status: "ACTIVE",
    },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Comparison" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  return { userId: user.id, projectId: project.id, siteId: site.id };
}

async function addCompetitor(seeded: Seeded, domain: string): Promise<string> {
  const site = await prisma.site.create({
    data: {
      projectId: seeded.projectId,
      url: `https://${domain}`,
      domain,
      role: "COMPETITOR",
    },
  });
  return site.id;
}

async function completedCrawl(siteId: string, seeded: Seeded, pages = 3): Promise<string> {
  const crawl = await prisma.crawl.create({
    data: {
      siteId,
      projectId: seeded.projectId,
      status: "COMPLETED",
      trigger: "MANUAL",
      pagesCrawled: pages,
      finishedAt: new Date(),
    },
  });
  for (let index = 0; index < pages; index += 1) {
    const page = await prisma.page.create({
      data: {
        siteId,
        url: `https://x.test/p${index}`,
        urlHash: `cmp-${crawl.id}-${index}`,
        latestContentHash: `c${index}`,
      },
    });
    await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: page.id,
        contentHash: `c${index}`,
        extracted: {},
        wordCount: 300,
        title: `Page ${index}`,
        storageKey: `k${index}`,
        fetchedAt: new Date(),
        pageUpdatedAt: new Date(),
        internalLinkCount: 10,
      },
    });
  }
  return crawl.id;
}

async function addScore(seeded: Seeded, crawlId: string, composite: number): Promise<void> {
  await new ScoresRepo(prisma).insert({
    projectId: seeded.projectId,
    crawlId,
    promptRunId: null,
    composite,
    citation: null,
    retrievability: 60,
    contentQuality: 70,
    topicCoverage: 50,
    technical: 90,
    trust: 45,
    components: { configVersion: "scoring.v1", components: [] },
    scoringConfigVersion: "scoring.v1",
  });
}

async function completedRun(
  seeded: Seeded,
  metrics: Record<string, unknown>,
): Promise<void> {
  const runs = new PromptRunsRepo(prisma);
  const run = await runs.create({ projectId: seeded.projectId, trigger: "SCHEDULED", engines: ["perplexity"] });
  await runs.finish(run.id, "COMPLETED", {
    mentionRate: 0.6,
    citationShare: 0.4,
    metrics,
    costUsdMicros: 0n,
  });
}

beforeAll(() => {
  prisma = createTestPrisma();
  deps = {
    projects: new ProjectsRepo(prisma),
    sites: new SitesRepo(prisma),
    crawls: new CrawlsRepo(prisma),
    scores: new ScoresRepo(prisma),
    siteFacts: new SiteFactsRepo(prisma),
    chunks: new ChunksRepo(prisma),
    topics: new TopicsRepo(prisma),
    coverage: new TopicCoverageRepo(prisma),
    runs: new PromptRunsRepo(prisma),
    users: new UsersRepo(prisma),
    clock: systemClock,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("no competitor tracked", () => {
  it("returns a null competitor column and no share of voice, not zeros", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded.siteId, seeded);
    await addScore(seeded, crawlId, 70);

    const result = await readComparison(deps, seeded.projectId, seeded.userId);

    if (!result.ok) throw result.error;
    expect(result.value.competitor).toBeNull();
    expect(result.value.shareOfVoice).toBeNull();
    expect(result.value.own.crawlId).toBe(crawlId);
    expect(result.value.own.metrics.aiVisibility).toBe(70);
    expect(result.value.missingTopics).toEqual([]);
  });
});

describe("a competitor added but never crawled", () => {
  it("gives the competitor column all-null metrics rather than treating it as crawled-empty", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded.siteId, seeded);
    await addScore(seeded, crawlId, 70);
    const rivalSiteId = await addCompetitor(seeded, "rival.com");

    const result = await readComparison(deps, seeded.projectId, seeded.userId);

    if (!result.ok) throw result.error;
    expect(result.value.competitor).not.toBeNull();
    expect(result.value.competitor?.siteId).toBe(rivalSiteId);
    expect(result.value.competitor?.crawlId).toBeNull();
    expect(result.value.competitor?.metrics).toEqual({
      aiVisibility: null,
      topicCoverage: null,
      authority: null,
      contentFreshness: null,
      pageCount: null,
      blogCoverage: null,
      trustSignals: null,
    });
  });
});

describe("both sites crawled, no prompt run yet", () => {
  it("fills in both columns and the missing-topic gaps, but leaves share of voice null", async () => {
    const seeded = await seedProject();
    const ownCrawlId = await completedCrawl(seeded.siteId, seeded);
    await addScore(seeded, ownCrawlId, 72);
    const rivalSiteId = await addCompetitor(seeded, "rival.com");
    const rivalCrawlId = await completedCrawl(rivalSiteId, seeded);

    const gap = await prisma.topic.create({
      data: { projectId: seeded.projectId, label: "Migration guides", source: "GENERATED", position: 0 },
    });
    await prisma.topicCoverage.createMany({
      data: [
        { crawlId: ownCrawlId, topicId: gap.id, coverageScore: 5, depthChunks: 0 },
        { crawlId: rivalCrawlId, topicId: gap.id, coverageScore: 85, depthChunks: 9 },
      ],
    });

    const result = await readComparison(deps, seeded.projectId, seeded.userId);

    if (!result.ok) throw result.error;
    expect(result.value.own.metrics.aiVisibility).toBe(72);
    expect(result.value.competitor?.crawlId).toBe(rivalCrawlId);
    // The competitor column never carries a composite — nobody computed one for it.
    expect(result.value.competitor?.metrics.aiVisibility).toBeNull();
    expect(result.value.shareOfVoice).toBeNull();
    expect(result.value.missingTopics).toHaveLength(1);
    expect(result.value.missingTopics[0]).toMatchObject({ label: "Migration guides", missing: true });
  });
});

describe("full data", () => {
  it("reads share of voice from the latest completed run without recomputing it", async () => {
    const seeded = await seedProject();
    const crawlId = await completedCrawl(seeded.siteId, seeded);
    await addScore(seeded, crawlId, 80);
    await addCompetitor(seeded, "rival.com");
    await completedRun(seeded, {
      shareOfVoice: 37,
      perEngine: [{ engine: "perplexity", citations: 5, shareOfVoice: 50 }],
      competitorCitations: { "rival.com": 5 },
    });

    const result = await readComparison(deps, seeded.projectId, seeded.userId);

    if (!result.ok) throw result.error;
    expect(result.value.shareOfVoice?.overall).toBe(37);
    expect(result.value.shareOfVoice?.perEngine).toHaveLength(1);
    expect(result.value.shareOfVoice?.competitorCitations).toEqual({ "rival.com": 5 });
  });

  it("computes authority and content freshness the same way for both columns", async () => {
    const seeded = await seedProject();
    const ownCrawlId = await completedCrawl(seeded.siteId, seeded);
    await addScore(seeded, ownCrawlId, 60);
    const rivalSiteId = await addCompetitor(seeded, "rival.com");
    const rivalCrawlId = await completedCrawl(rivalSiteId, seeded);

    const result = await readComparison(deps, seeded.projectId, seeded.userId);

    if (!result.ok) throw result.error;
    // Both fixtures use the identical internal-link count and dating, so both columns
    // should land on the identical authority and freshness figures — that symmetry is
    // the entire point of computing them through one shared function.
    expect(result.value.own.metrics.authority).toBe(result.value.competitor?.metrics.authority);
    expect(result.value.own.metrics.contentFreshness).toBe(
      result.value.competitor?.metrics.contentFreshness,
    );
    expect(result.value.own.crawlId).toBe(ownCrawlId);
    expect(result.value.competitor?.crawlId).toBe(rivalCrawlId);
  });
});

describe("access control", () => {
  it("404s a project with no own site", async () => {
    const user = await prisma.user.create({
      data: { email: `nosite-${Date.now()}@example.test` },
    });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        stripeCustomerId: `cus_${randomUUID()}`,
        plan: "PRO",
        status: "ACTIVE",
      },
    });
    const project = await prisma.project.create({ data: { userId: user.id, name: "No Site" } });

    const result = await readComparison(deps, project.id, user.id);

    expect(result.ok).toBe(false);
  });

  it("blocks a FREE-plan account with PLAN_LIMIT_EXCEEDED (M19)", async () => {
    const user = await prisma.user.create({
      data: { email: `free-cmp-${Date.now()}@example.test` },
    });
    const project = await prisma.project.create({ data: { userId: user.id, name: "Free Plan" } });
    await prisma.site.create({
      data: { projectId: project.id, url: "https://free.com", domain: "free.com", role: "OWN" },
    });

    const result = await readComparison(deps, project.id, user.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("refuses a stranger rather than serving another account's comparison", async () => {
    const owner = await seedProject();
    const stranger = await prisma.user.create({
      data: { email: `stranger-${Date.now()}@example.test` },
    });

    const result = await readComparison(deps, owner.projectId, stranger.id);

    expect(result.ok).toBe(false);
  });
});
