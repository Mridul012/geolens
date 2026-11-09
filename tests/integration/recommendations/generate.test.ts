/**
 * The recommendations engine end to end (M13 acceptance).
 *
 * The three claims worth proving against a real database:
 *   · a broken fixture produces the expected rule cards, with the right priorities and
 *     evidence that actually resolves;
 *   · the same issue seen on two consecutive crawls is one card, not two;
 *   · a model suggestion citing evidence we cannot resolve is dropped, never half-saved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { generateRecommendations } from "../../../src/application/recommendations/generate-recommendations.js";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import type { ProviderAdapter } from "../../../src/infrastructure/ai/adapters/provider.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { loadPrompt, render } from "../../../src/infrastructure/ai/prompts/registry.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { RecommendationsRepo } from "../../../src/infrastructure/db/repositories/recommendations.repo.js";
import { SiteFactsRepo } from "../../../src/infrastructure/db/repositories/site-facts.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { tierConfigFor } from "../../../src/config/model-tiers.js";
import { systemClock } from "../../../src/application/ports/clock.port.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let crawls: CrawlsRepo;
let sites: SitesRepo;
let topics: TopicsRepo;
let coverage: TopicCoverageRepo;
let siteFacts: SiteFactsRepo;
let recommendations: RecommendationsRepo;
let usage: AiUsageRepo;

const log = pino({ level: "silent" });

function deps(adapter: ProviderAdapter = new FakeAdapter()) {
  return {
    gateway: new ProviderGateway({
      config: tierConfigFor("fake"),
      adapters: { fake: adapter },
      usage,
      budget: new BudgetGuard(usage, { perCrawlMicros: 5_000_000n, perRunMicros: 5_000_000n }),
      tracer: createLoggingTracer(log),
    }),
    crawls,
    sites,
    topics,
    coverage,
    siteFacts,
    recommendations,
    clock: systemClock,
    prompt: loadPrompt,
    render,
    log,
  };
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
  readonly metaDescription?: boolean;
  readonly linksTo?: readonly string[];
  readonly updatedAt?: Date | null;
}

/** A site that is wrong in every way a rule can detect. */
const BROKEN_PAGES: readonly PageSpec[] = [
  { path: "/", linksTo: ["/pricing"], structuredData: false, metaDescription: false },
  { path: "/pricing", wordCount: 40, structuredData: false, metaDescription: false },
  { path: "/orphan", wordCount: 400, structuredData: false, metaDescription: false },
  {
    path: "/ancient",
    wordCount: 800,
    structuredData: false,
    metaDescription: false,
    updatedAt: new Date("2015-01-01T00:00:00Z"),
  },
];

async function seed(
  pages: readonly PageSpec[] = BROKEN_PAGES,
  artifact: Record<string, unknown> = {},
  existing?: { projectId: string; siteId: string },
): Promise<Seeded> {
  let projectId = existing?.projectId;
  let siteId = existing?.siteId;

  if (projectId === undefined || siteId === undefined) {
    const user = await prisma.user.create({
      data: { email: `rec-${Date.now()}-${Math.random()}@example.test` },
    });
    const project = await prisma.project.create({ data: { userId: user.id, name: "Recs" } });
    const site = await prisma.site.create({
      data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
    });
    projectId = project.id;
    siteId = site.id;
  }

  const crawl = await prisma.crawl.create({
    data: {
      siteId,
      projectId,
      status: "ANALYZING",
      trigger: "MANUAL",
      pagesCrawled: pages.length,
      analysis: {
        accessCheck: {
          allowedShare: 0,
          bots: [
            { bot: "GPTBot", allowed: false, blockedBy: "robots", fix: "User-agent: GPTBot\nAllow: /" },
            { bot: "PerplexityBot", allowed: false, blockedBy: "cdn", fix: null },
            { bot: "ClaudeBot", allowed: true, blockedBy: null, fix: null },
          ],
          llmsTxt: { present: false, valid: null, issues: [] },
        },
        discovery: { source: "links", sitemapPresent: false },
        retrievability: {
          available: true,
          score: 20,
          topGaps: [
            { question: "What does the Growth plan cost?", missingElement: "a price" },
            { question: "Are you SOC 2 certified?", missingElement: "a certification list" },
          ],
        },
        ...artifact,
      },
    },
  });

  for (const [index, page] of pages.entries()) {
    const existingPage = await prisma.page.findFirst({
      where: { siteId, url: `https://acme.com${page.path}` },
    });
    const row =
      existingPage ??
      (await prisma.page.create({
        data: {
          siteId,
          url: `https://acme.com${page.path}`,
          urlHash: `rec-${siteId}-${index}`,
          latestContentHash: `c${index}`,
        },
      }));

    await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: row.id,
        contentHash: `c${index}`,
        httpStatus: 200,
        title: `Page ${index}`,
        wordCount: page.wordCount ?? 600,
        hasStructuredData: page.structuredData ?? true,
        internalLinkCount: (page.linksTo ?? []).length,
        ...(page.updatedAt === undefined || page.updatedAt === null
          ? {}
          : { pageUpdatedAt: page.updatedAt }),
        extracted: {
          canonical: `https://acme.com${page.path}`,
          metaDescription: (page.metaDescription ?? true) ? `About ${page.path}` : null,
          links: (page.linksTo ?? []).map((href) => ({
            href: `https://acme.com${href}`,
            text: href,
            rel: null,
            internal: true,
            nofollow: false,
          })),
          signals: { hasAuthor: false, outboundCitationCount: 0 },
        },
        storageKey: `k${index}`,
        fetchedAt: new Date(),
      },
    });
  }

  return { projectId, siteId, crawlId: crawl.id };
}

async function keysFor(projectId: string): Promise<readonly string[]> {
  const rows = await prisma.recommendation.findMany({
    where: { projectId },
    select: { ruleKey: true },
  });
  return rows.flatMap((row) => (row.ruleKey === null ? [] : [row.ruleKey]));
}

beforeAll(() => {
  prisma = createTestPrisma();
  crawls = new CrawlsRepo(prisma);
  sites = new SitesRepo(prisma);
  topics = new TopicsRepo(prisma);
  coverage = new TopicCoverageRepo(prisma);
  siteFacts = new SiteFactsRepo(prisma);
  recommendations = new RecommendationsRepo(prisma);
  usage = new AiUsageRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("a broken fixture", () => {
  it("produces the expected rule cards", async () => {
    const seeded = await seed();

    const result = await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const keys = await keysFor(seeded.projectId);
    expect(keys).toContain("blocked-ai-crawlers");
    expect(keys).toContain("llms-txt-missing");
    expect(keys).toContain("sitemap-missing");
    expect(keys).toContain("structured-data-missing");
    expect(keys).toContain("thin-content");
    expect(keys).toContain("orphan-pages");
    expect(keys).toContain("meta-description-missing");
    expect(keys).toContain("stale-content");
    expect(keys).toContain("unanswered-buyer-questions");
  });

  it("puts the blocked crawlers at the top as CRITICAL", async () => {
    const seeded = await seed();
    await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    const [first] = await recommendations.listForProject(seeded.projectId, { limit: 1 });
    expect(first?.priority).toBe("CRITICAL");
    expect(first?.title).toContain("Unblock");
  });

  it("links evidence that actually resolves to a snapshot", async () => {
    const seeded = await seed();
    await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    const thin = await prisma.recommendation.findFirstOrThrow({
      where: { projectId: seeded.projectId, ruleKey: "thin-content" },
    });
    const ids = (thin.evidence as { snapshotIds?: string[] }).snapshotIds ?? [];
    expect(ids.length).toBeGreaterThan(0);

    const found = await prisma.pageSnapshot.count({ where: { id: { in: ids } } });
    expect(found).toBe(ids.length);
  });

  it("finds the orphan page by inbound links, not outbound ones", async () => {
    const seeded = await seed();
    await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    const orphans = await prisma.recommendation.findFirstOrThrow({
      where: { projectId: seeded.projectId, ruleKey: "orphan-pages" },
    });
    const urls = (orphans.evidence as { urls?: string[] }).urls ?? [];
    // The homepage links only to /pricing, so /orphan and /ancient are orphaned — and the
    // homepage itself never is, whatever links to it.
    expect(urls).toContain("https://acme.com/orphan");
    expect(urls).not.toContain("https://acme.com/");
  });

  it("stays silent on a healthy site", async () => {
    const seeded = await seed(
      [{ path: "/", linksTo: ["/pricing"] }, { path: "/pricing" }],
      {
        accessCheck: {
          allowedShare: 100,
          bots: [{ bot: "GPTBot", allowed: true, blockedBy: null, fix: null }],
          llmsTxt: { present: true, valid: true, issues: [] },
        },
        discovery: { source: "sitemap", sitemapPresent: true },
        retrievability: { available: true, score: 90, topGaps: [] },
      },
    );

    await generateRecommendations(deps(), {
      ...seeded,
      composite: 88,
      components: { components: [] },
    });

    const keys = await keysFor(seeded.projectId);
    expect(keys).not.toContain("blocked-ai-crawlers");
    expect(keys).not.toContain("llms-txt-missing");
    expect(keys).not.toContain("sitemap-missing");
  });
});

describe("dedupe across crawls", () => {
  it("keeps one card when the same issue is seen twice", async () => {
    const first = await seed();
    await generateRecommendations(deps(), {
      ...first,
      composite: 30,
      components: { components: [] },
    });
    const afterFirst = await prisma.recommendation.count({ where: { projectId: first.projectId } });

    await prisma.crawl.update({
      where: { id: first.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const second = await seed(BROKEN_PAGES, {}, { projectId: first.projectId, siteId: first.siteId });
    await generateRecommendations(deps(), {
      ...second,
      composite: 30,
      components: { components: [] },
    });

    expect(await prisma.recommendation.count({ where: { projectId: first.projectId } })).toBe(
      afterFirst,
    );
  });

  it("updates last_seen without resetting when the issue was first found", async () => {
    const first = await seed();
    await generateRecommendations(deps(), {
      ...first,
      composite: 30,
      components: { components: [] },
    });
    const before = await prisma.recommendation.findFirstOrThrow({
      where: { projectId: first.projectId, ruleKey: "blocked-ai-crawlers" },
    });

    await prisma.crawl.update({
      where: { id: first.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const second = await seed(BROKEN_PAGES, {}, { projectId: first.projectId, siteId: first.siteId });
    await generateRecommendations(deps(), {
      ...second,
      composite: 30,
      components: { components: [] },
    });

    const after = await prisma.recommendation.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.lastSeenCrawlId).toBe(second.crawlId);
    // "You have had this problem since March" is the card's most useful fact.
    expect(after.firstSeenCrawlId).toBe(first.crawlId);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it("never overwrites the user's decision about a card", async () => {
    const first = await seed();
    await generateRecommendations(deps(), {
      ...first,
      composite: 30,
      components: { components: [] },
    });
    const card = await prisma.recommendation.findFirstOrThrow({
      where: { projectId: first.projectId, ruleKey: "stale-content" },
    });
    await prisma.recommendation.update({ where: { id: card.id }, data: { status: "DISMISSED" } });

    await prisma.crawl.update({
      where: { id: first.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const second = await seed(BROKEN_PAGES, {}, { projectId: first.projectId, siteId: first.siteId });
    await generateRecommendations(deps(), {
      ...second,
      composite: 30,
      components: { components: [] },
    });

    const after = await prisma.recommendation.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe("DISMISSED");
  });

  it("validates a fix the user claimed once the issue is gone", async () => {
    const first = await seed();
    await generateRecommendations(deps(), {
      ...first,
      composite: 30,
      components: { components: [] },
    });
    const blocked = await prisma.recommendation.findFirstOrThrow({
      where: { projectId: first.projectId, ruleKey: "blocked-ai-crawlers" },
    });
    await prisma.recommendation.update({ where: { id: blocked.id }, data: { status: "DONE" } });

    // Second crawl: the bots are unblocked.
    await prisma.crawl.update({
      where: { id: first.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const second = await seed(
      BROKEN_PAGES,
      {
        accessCheck: {
          allowedShare: 100,
          bots: [{ bot: "GPTBot", allowed: true, blockedBy: null, fix: null }],
          llmsTxt: { present: false, valid: null, issues: [] },
        },
      },
      { projectId: first.projectId, siteId: first.siteId },
    );
    await generateRecommendations(deps(), {
      ...second,
      composite: 55,
      components: { components: [] },
    });

    const after = await prisma.recommendation.findUniqueOrThrow({ where: { id: blocked.id } });
    expect(after.status).toBe("VALIDATED");
    expect(after.resolvedAt).not.toBeNull();
  });

  it("calls out a fix that did not hold", async () => {
    const first = await seed();
    await generateRecommendations(deps(), {
      ...first,
      composite: 30,
      components: { components: [] },
    });
    const blocked = await prisma.recommendation.findFirstOrThrow({
      where: { projectId: first.projectId, ruleKey: "blocked-ai-crawlers" },
    });
    await prisma.recommendation.update({ where: { id: blocked.id }, data: { status: "DONE" } });

    // Second crawl: still blocked.
    await prisma.crawl.update({
      where: { id: first.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
    const second = await seed(BROKEN_PAGES, {}, { projectId: first.projectId, siteId: first.siteId });
    await generateRecommendations(deps(), {
      ...second,
      composite: 30,
      components: { components: [] },
    });

    const after = await prisma.recommendation.findUniqueOrThrow({ where: { id: blocked.id } });
    expect(after.status).toBe("REGRESSED");
  });
});

describe("model suggestions", () => {
  it("keeps a suggestion whose evidence resolves", async () => {
    const seeded = await seed();
    const result = await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    if (!result.ok) throw result.error;
    expect(result.value.aiSuggestions).toBeGreaterThan(0);
    const ai = await prisma.recommendation.findMany({
      where: { projectId: seeded.projectId, source: "AI" },
    });
    expect(ai.length).toBe(result.value.aiSuggestions);
  });

  it("drops one citing a snapshot that is not in the analysis, and saves nothing", async () => {
    const seeded = await seed();
    const inventing: ProviderAdapter = {
      name: "fake",
      complete: async (request) => {
        if (request.system.toLowerCase().includes("advise")) {
          return {
            text: JSON.stringify({
              recommendations: [
                {
                  title: "Rewrite a page that does not exist",
                  body: "Cites a snapshot id nobody supplied.",
                  ruleHint: null,
                  impact: 4,
                  difficulty: 2,
                  evidenceRefs: { snapshotIds: ["00000000-0000-4000-8000-000000000000"] },
                },
              ],
            }),
            usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
            citations: [],
          };
        }
        return new FakeAdapter().complete(request);
      },
      embed: (request) => new FakeAdapter().embed(request),
    };

    const result = await generateRecommendations(deps(inventing), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    if (!result.ok) throw result.error;
    expect(result.value.aiDropped).toBe(1);
    expect(result.value.aiSuggestions).toBe(0);
    expect(
      await prisma.recommendation.count({ where: { projectId: seeded.projectId, source: "AI" } }),
    ).toBe(0);
    // …and the rule cards still stand on their own.
    expect(
      await prisma.recommendation.count({ where: { projectId: seeded.projectId, source: "RULE" } }),
    ).toBeGreaterThan(0);
  });

  it("drops one that merely restates a rule", async () => {
    const seeded = await seed();
    const duplicating: ProviderAdapter = {
      name: "fake",
      complete: async (request) => {
        if (request.system.toLowerCase().includes("advise")) {
          return {
            text: JSON.stringify({
              recommendations: [
                {
                  title: "Unblock the AI crawlers",
                  body: "The rules engine already found this.",
                  ruleHint: "blocked-ai-crawlers",
                  impact: 5,
                  difficulty: 1,
                  evidenceRefs: { checkKeys: ["GPTBot"] },
                },
              ],
            }),
            usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
            citations: [],
          };
        }
        return new FakeAdapter().complete(request);
      },
      embed: (request) => new FakeAdapter().embed(request),
    };

    const result = await generateRecommendations(deps(duplicating), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    if (!result.ok) throw result.error;
    expect(result.value.aiDropped).toBe(1);
    expect(
      await prisma.recommendation.count({ where: { projectId: seeded.projectId, source: "AI" } }),
    ).toBe(0);
  });

  it("never lets a model declare something CRITICAL", async () => {
    const seeded = await seed();
    await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    const ai = await prisma.recommendation.findMany({
      where: { projectId: seeded.projectId, source: "AI" },
      select: { priority: true },
    });
    expect(ai.every((row) => row.priority !== "CRITICAL")).toBe(true);
  });

  it("still produces the rule cards when the model is unavailable", async () => {
    const seeded = await seed();
    const broken: ProviderAdapter = {
      name: "fake",
      complete: async (request) => {
        if (request.system.toLowerCase().includes("advise")) throw new Error("provider down");
        return new FakeAdapter().complete(request);
      },
      embed: (request) => new FakeAdapter().embed(request),
    };

    const result = await generateRecommendations(deps(broken), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aiSuggestions).toBe(0);
    expect(result.value.ruleFindings).toBeGreaterThan(0);
    expect(
      await prisma.recommendation.count({ where: { projectId: seeded.projectId, source: "RULE" } }),
    ).toBe(result.value.ruleFindings);
  });

  it("meters the call", async () => {
    const seeded = await seed();
    await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });
    expect((await usage.countsByPurpose(seeded.crawlId))["recommendations"]).toBe(1);
  });
});

describe("competitor gaps", () => {
  it("raises a topic the competitor owns", async () => {
    const seeded = await seed();
    const rival = await prisma.site.create({
      data: {
        projectId: seeded.projectId,
        url: "https://rival.com",
        domain: "rival.com",
        role: "COMPETITOR",
      },
    });
    const rivalCrawl = await prisma.crawl.create({
      data: {
        siteId: rival.id,
        projectId: seeded.projectId,
        status: "COMPLETED",
        trigger: "MANUAL",
        finishedAt: new Date(),
      },
    });
    const topic = await prisma.topic.create({
      data: {
        projectId: seeded.projectId,
        label: "Migration guides",
        source: "GENERATED",
        position: 0,
      },
    });
    await prisma.topicCoverage.createMany({
      data: [
        { crawlId: seeded.crawlId, topicId: topic.id, coverageScore: 4, depthChunks: 0 },
        { crawlId: rivalCrawl.id, topicId: topic.id, coverageScore: 88, depthChunks: 9 },
      ],
    });

    await generateRecommendations(deps(), {
      ...seeded,
      composite: 30,
      components: { components: [] },
    });

    const card = await prisma.recommendation.findFirstOrThrow({
      where: { projectId: seeded.projectId, ruleKey: "missing-topics" },
    });
    expect(card.priority).toBe("HIGH");
    expect((card.evidence as { topicLabels?: string[] }).topicLabels).toEqual([
      "Migration guides",
    ]);
  });
});
