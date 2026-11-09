/**
 * Taxonomy generation end to end (M9 acceptance): a crawled fixture site yields sensible,
 * editable topics; the call lands in the ledger; and a failure degrades honestly rather
 * than inventing a taxonomy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { generateTaxonomy } from "../../../src/application/analysis/generate-taxonomy.js";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import type { ProviderAdapter } from "../../../src/infrastructure/ai/adapters/provider.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { loadPrompt, render } from "../../../src/infrastructure/ai/prompts/registry.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { tierConfigFor } from "../../../src/config/model-tiers.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
const log = pino({ level: "silent" });

interface Seeded {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
}

async function seedCrawledSite(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `tax-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Taxonomy" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: { siteId: site.id, projectId: project.id, status: "ANALYZING", trigger: "MANUAL" },
  });

  const pages = [
    { path: "/", title: "Acme — AI search analytics", links: 0 },
    { path: "/pricing", title: "Pricing", links: 12 },
    { path: "/docs", title: "Documentation", links: 9 },
    { path: "/security", title: "Security and compliance", links: 6 },
  ];

  for (const [index, page] of pages.entries()) {
    const row = await prisma.page.create({
      data: {
        siteId: site.id,
        url: `https://acme.com${page.path}`,
        urlHash: `hash-${index}`,
        latestContentHash: `content-${index}`,
      },
    });
    await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: row.id,
        contentHash: `content-${index}`,
        title: page.title,
        wordCount: 500,
        internalLinkCount: page.links,
        extracted: {
          title: page.title,
          metaDescription: `${page.title} description`,
          headings: [{ level: 1, text: page.title, path: page.title }],
        },
        storageKey: `k-${index}`,
        fetchedAt: new Date(),
      },
    });
  }

  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

function buildDeps(adapter: ProviderAdapter) {
  const usage = new AiUsageRepo(prisma);
  return {
    gateway: new ProviderGateway({
      config: tierConfigFor("fake"),
      adapters: { fake: adapter },
      usage,
      budget: new BudgetGuard(usage, { perCrawlMicros: 500_000n, perRunMicros: 300_000n }),
      tracer: createLoggingTracer(log),
    }),
    crawls: new CrawlsRepo(prisma),
    sites: new SitesRepo(prisma),
    topics: new TopicsRepo(prisma),
    prompt: loadPrompt,
    render,
    log,
  };
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

describe("generateTaxonomy", () => {
  it("produces 12–20 editable topics with embeddings from a crawled site", async () => {
    const seeded = await seedCrawledSite();

    const result = await generateTaxonomy(buildDeps(new FakeAdapter()), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topicsCreated).toBeGreaterThanOrEqual(12);
    expect(result.value.topicsCreated).toBeLessThanOrEqual(20);
    expect(result.value.niche.length).toBeGreaterThan(0);

    const topics = await prisma.topic.findMany({ where: { projectId: seeded.projectId } });
    expect(topics).toHaveLength(result.value.topicsCreated);
    expect(topics.every((topic) => topic.source === "GENERATED")).toBe(true);
    expect(topics.every((topic) => topic.status === "ACTIVE")).toBe(true);
    // Positions are dense and ordered, so the UI can render and reorder them.
    expect(topics.map((topic) => topic.position).sort((a, b) => a - b)).toEqual(
      topics.map((_topic, index) => index),
    );

    // Every topic has its centroid, which is what maps chunks to topics in M10.
    expect(result.value.embeddingsStored).toBe(result.value.topicsCreated);
    const withEmbedding = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM topics WHERE project_id = $1::uuid AND embedding IS NOT NULL`,
      seeded.projectId,
    );
    expect(Number(withEmbedding[0]?.count ?? 0)).toBe(result.value.topicsCreated);
  });

  it("meters both the generation and the embedding calls", async () => {
    const seeded = await seedCrawledSite();
    await generateTaxonomy(buildDeps(new FakeAdapter()), seeded);

    const purposes = await new AiUsageRepo(prisma).countsByPurpose(seeded.crawlId);
    expect(purposes).toEqual({ taxonomy: 1, "taxonomy-embedding": 1 });
  });

  it("records the taxonomy block in the crawl's analysis artifact", async () => {
    const seeded = await seedCrawledSite();
    await generateTaxonomy(buildDeps(new FakeAdapter()), seeded);

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    const analysis = crawl.analysis as { taxonomy?: Record<string, unknown> };
    expect(analysis.taxonomy).toMatchObject({ available: true, promptId: "taxonomy/v1" });
  });

  it("gives the model the homepage first, however few links it has", async () => {
    const seeded = await seedCrawledSite();
    const seen: string[] = [];
    const spy: ProviderAdapter = {
      name: "fake",
      complete: async (request) => {
        seen.push(request.user);
        return new FakeAdapter().complete(request);
      },
      embed: (request) => new FakeAdapter().embed(request),
    };

    await generateTaxonomy(buildDeps(spy), seeded);

    const prompt = seen[0] ?? "";
    // The homepage has zero internal links but is the site's own summary of itself.
    expect(prompt.indexOf("https://acme.com/\n")).toBeLessThan(prompt.indexOf("/pricing"));
    // Page content is delimited as untrusted third-party data (AI-Pipeline §6.1).
    expect(prompt).toContain("<untrusted-site-content>");
  });

  it("degrades honestly when generation fails — no invented taxonomy", async () => {
    const seeded = await seedCrawledSite();
    const broken: ProviderAdapter = {
      name: "fake",
      complete: async () => ({
        text: "I cannot produce that.",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
        citations: [],
      }),
      embed: (request) => new FakeAdapter().embed(request),
    };

    const result = await generateTaxonomy(buildDeps(broken), seeded);

    expect(result.ok).toBe(false);
    expect(await prisma.topic.count()).toBe(0);

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    const analysis = crawl.analysis as { taxonomy?: Record<string, unknown> };
    expect(analysis.taxonomy).toEqual({ available: false, reason: "generation_failed" });
  });

  it("keeps the taxonomy when only the embeddings fail", async () => {
    const seeded = await seedCrawledSite();
    const noEmbeddings: ProviderAdapter = {
      name: "fake",
      complete: (request) => new FakeAdapter().complete(request),
      embed: async () => {
        throw new Error("embedding provider down");
      },
    };

    const result = await generateTaxonomy(buildDeps(noEmbeddings), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Topics are saved and editable; only coverage is affected.
    expect(result.value.topicsCreated).toBeGreaterThanOrEqual(12);
    expect(result.value.embeddingsStored).toBe(0);
  });

  it("archives the previous generated set on regeneration, keeping user topics", async () => {
    const seeded = await seedCrawledSite();
    await generateTaxonomy(buildDeps(new FakeAdapter()), seeded);

    const userTopic = await prisma.topic.create({
      data: {
        projectId: seeded.projectId,
        label: "A topic the user added",
        source: "USER",
        position: 99,
      },
    });

    await generateTaxonomy(buildDeps(new FakeAdapter()), seeded);

    const archived = await prisma.topic.count({
      where: { projectId: seeded.projectId, status: "ARCHIVED" },
    });
    expect(archived).toBeGreaterThanOrEqual(12);

    // The user's own work survives regeneration untouched.
    const survivor = await prisma.topic.findUniqueOrThrow({ where: { id: userTopic.id } });
    expect(survivor.status).toBe("ACTIVE");
  });

  it("refuses when the crawl captured no pages", async () => {
    const user = await prisma.user.create({ data: { email: `empty-${Date.now()}@example.test` } });
    const project = await prisma.project.create({ data: { userId: user.id, name: "Empty" } });
    const site = await prisma.site.create({
      data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
    });
    const crawl = await prisma.crawl.create({
      data: { siteId: site.id, projectId: project.id, status: "ANALYZING", trigger: "MANUAL" },
    });

    const result = await generateTaxonomy(buildDeps(new FakeAdapter()), {
      projectId: project.id,
      siteId: site.id,
      crawlId: crawl.id,
    });

    expect(result.ok).toBe(false);
    expect(await prisma.topic.count()).toBe(0);
  });
});

describe("the prompt registry", () => {
  it("loads the frozen taxonomy prompt with both sections", () => {
    const prompt = loadPrompt("taxonomy", "v1");
    expect(prompt.id).toBe("taxonomy/v1");
    expect(prompt.frontmatter["tier"]).toBe("frontier");
    expect(prompt.system).toContain("market analyst");
    expect(prompt.user).toContain("{{siteDomain}}");
  });

  it("throws on a missing variable rather than rendering a blank hole", () => {
    const prompt = loadPrompt("taxonomy", "v1");
    expect(() => render(prompt.user, { siteDomain: "acme.com" })).toThrow(/homepageTitle/);
  });

  it("throws for a prompt version that does not exist", () => {
    expect(() => loadPrompt("taxonomy", "v99")).toThrow(/Prompt not found/);
  });
});
