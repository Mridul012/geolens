/**
 * Retrievability simulation end to end (M11 acceptance).
 *
 * Real Postgres with real pgvector and real FTS, the real gateway, the real ledger, and
 * the real RRF fusion — the questions and the verdict come from the fake adapter, which
 * for this component is genuinely content-sensitive: it derives its questions from the
 * taxonomy it is given and judges by comparing the question against the passages that were
 * actually retrieved. Crude, but a function of the site's content, which is exactly the
 * property "rich scores higher than thin" needs to be a real result rather than a coin
 * flip that happened to land the right way.
 *
 * The three acceptance criteria:
 *   1. a rich fixture site scores visibly higher than a thin one;
 *   2. per-question pass/fail detail is retrievable as evidence;
 *   3. a judge outage null-flags the component and the crawl still completes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { indexPages } from "../../../src/application/indexing/index-pages.js";
import { simulateRetrievability } from "../../../src/application/analysis/simulate-retrievability.js";
import { aggregateCrawl } from "../../../src/application/crawls/aggregate-crawl.js";
import { getAnalysis } from "../../../src/application/analysis/read-analysis.js";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import type {
  CompletionRequest,
  ProviderAdapter,
} from "../../../src/infrastructure/ai/adapters/provider.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { loadPrompt, render } from "../../../src/infrastructure/ai/prompts/registry.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../../../src/infrastructure/db/repositories/events.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { RedisProgressStore } from "../../../src/infrastructure/redis/progress-store.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { tierConfigFor } from "../../../src/config/model-tiers.js";
import { RETRIEVABILITY_V1 } from "../../../src/config/scoring/retrievability.v1.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";
import { SubjectAdapter } from "../../helpers/subject-adapter.js";
import { OWN_PAGES, THIN_PAGES, seedProject } from "../../helpers/content-site.js";

let prisma: PrismaClient;
let redis: RedisClient;
let chunks: ChunksRepo;
let crawls: CrawlsRepo;
let sites: SitesRepo;
let topics: TopicsRepo;
let events: EventsRepo;
let progress: RedisProgressStore;
let usage: AiUsageRepo;

const log = pino({ level: "silent" });

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

function buildGateway(adapter: ProviderAdapter): ProviderGateway {
  return new ProviderGateway({
    config: tierConfigFor("fake"),
    adapters: { fake: adapter },
    usage,
    budget: new BudgetGuard(usage, { perCrawlMicros: 50_000_000n, perRunMicros: 50_000_000n }),
    tracer: createLoggingTracer(log),
  });
}

function retrievabilityDeps(adapter: ProviderAdapter) {
  return {
    gateway: buildGateway(adapter),
    chunks,
    crawls,
    sites,
    topics,
    prompt: loadPrompt,
    render,
    log,
  };
}

/** Seeds a project, its taxonomy with centroids, and its indexed corpus. */
async function seedIndexed(
  pages: readonly (typeof OWN_PAGES)[number][],
  domain: string,
  adapter: ProviderAdapter = new SubjectAdapter(),
) {
  const seeded = await seedProject(prisma, pages, domain);

  const created = await topics.replaceGenerated(
    seeded.projectId,
    TAXONOMY.map((topic, position) => ({
      label: topic.label,
      description: topic.description,
      source: "GENERATED" as const,
      position,
    })),
  );
  const embedded = await buildGateway(adapter).embed({
    inputs: TAXONOMY.map((topic) => `${topic.label}. ${topic.description}`),
    context: { purpose: "taxonomy-embedding", projectId: seeded.projectId },
  });
  if (!embedded.ok) throw new Error("fixture taxonomy failed to embed");
  for (const [index, topic] of created.entries()) {
    await topics.setEmbedding(topic.id, embedded.value.vectors[index] as number[]);
  }
  await crawls.mergeAnalysis(seeded.own.crawlId, {
    taxonomy: { available: true, niche: "AI search analytics" },
  });

  const indexed = await indexPages(
    { gateway: buildGateway(adapter), chunks, crawls, log },
    {
      crawlId: seeded.own.crawlId,
      projectId: seeded.projectId,
      snapshotIds: seeded.own.snapshotIds,
    },
  );
  if (!indexed.ok) throw new Error("fixture failed to index");

  return seeded;
}

/** An adapter whose judge is unreachable; question generation still works. */
function judgeOutage(): ProviderAdapter {
  const inner = new SubjectAdapter();
  return {
    name: "fake",
    complete: async (request: CompletionRequest) => {
      if (request.system.toLowerCase().includes("judge")) {
        throw new Error("judge provider unavailable");
      }
      return inner.complete(request);
    },
    embed: (request) => inner.embed(request),
  };
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  chunks = new ChunksRepo(prisma);
  crawls = new CrawlsRepo(prisma);
  sites = new SitesRepo(prisma);
  topics = new TopicsRepo(prisma);
  events = new EventsRepo(prisma);
  progress = new RedisProgressStore(redis);
  usage = new AiUsageRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("the simulation", () => {
  it("asks 30–50 questions, judges them, and scores the site", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");

    const result = await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questionsTotal).toBeGreaterThanOrEqual(RETRIEVABILITY_V1.minQuestions);
    expect(result.value.questionsTotal).toBeLessThanOrEqual(RETRIEVABILITY_V1.maxQuestions);
    expect(result.value.questionsJudged).toBe(result.value.questionsTotal);
    expect(result.value.degraded).toBe(false);
    expect(result.value.score).not.toBeNull();
  });

  it("meters the question call, the question embeddings, and one judge call per question", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");

    const result = await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });
    if (!result.ok) throw result.error;

    const purposes = await usage.countsByPurpose(seeded.own.crawlId);
    expect(purposes["retrievability-questions"]).toBe(1);
    expect(purposes["retrievability-question-embedding"]).toBe(1);
    expect(purposes["retrievability-judge"]).toBe(result.value.questionsTotal);
  });

  it("hands the judge the fused top chunks, and no more", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");
    const seen: string[] = [];
    const spy: ProviderAdapter = {
      name: "fake",
      complete: async (request) => {
        if (request.system.toLowerCase().includes("judge")) seen.push(request.user);
        return new SubjectAdapter().complete(request);
      },
      embed: (request) => new SubjectAdapter().embed(request),
    };

    await simulateRetrievability(retrievabilityDeps(spy), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    const prompt = seen[0] ?? "";
    // Passages are delimited as untrusted third-party data (AI-Pipeline §6.1)…
    expect(prompt).toContain("<untrusted-site-content>");
    expect(prompt).toContain("<question>");
    // …and there are at most `contextChunks` of them, each carrying its source URL.
    const passages = prompt.split("\n\n---\n\n").length;
    expect(passages).toBeLessThanOrEqual(RETRIEVABILITY_V1.contextChunks);
    expect(prompt).toContain("https://acme.com/");
  });
});

describe("rich versus thin", () => {
  it("scores a site with real content visibly higher than one with none", async () => {
    const rich = await seedIndexed(OWN_PAGES, "rich.example");
    const thin = await seedIndexed(THIN_PAGES, "thin.example");

    const richResult = await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: rich.projectId,
      crawlId: rich.own.crawlId,
      siteId: rich.own.siteId,
    });
    const thinResult = await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: thin.projectId,
      crawlId: thin.own.crawlId,
      siteId: thin.own.siteId,
    });

    if (!richResult.ok) throw richResult.error;
    if (!thinResult.ok) throw thinResult.error;

    const richScore = richResult.value.score ?? 0;
    const thinScore = thinResult.value.score ?? 0;

    // Direction is the claim, and the gap has to be one a customer would notice.
    // The margin is the finding, not just the pass: print it so a change that narrows it
    // shows up in CI output rather than only when the assertion finally trips.
    console.log(`retrievability: rich=${richScore} thin=${thinScore}`);
    expect(richScore).toBeGreaterThan(thinScore);
    expect(richScore - thinScore).toBeGreaterThanOrEqual(20);
    expect(richResult.value.questionsUnanswered).toBeLessThan(
      thinResult.value.questionsUnanswered,
    );
  });
});

describe("evidence", () => {
  it("stores what was asked, the verdict, and the chunks it was judged on", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");
    const result = await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });
    if (!result.ok) throw result.error;

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    const block = (crawl.analysis as { retrievability?: Record<string, unknown> }).retrievability;
    const questions = block?.["questions"] as Array<Record<string, unknown>>;

    expect(block).toMatchObject({
      available: true,
      thresholdsVersion: "retrievability.v1",
      promptIds: ["buyer-questions/v1", "retrievability-judge/v1"],
    });
    expect(questions).toHaveLength(result.value.questionsTotal);
    expect(questions[0]).toMatchObject({
      question: expect.any(String),
      topicLabel: expect.any(String),
      answered: expect.any(String),
    });

    // The chunk ids really point at chunks of this crawl.
    const ids = questions.flatMap((question) => question["chunkIds"] as string[]);
    expect(ids.length).toBeGreaterThan(0);
    const [found] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM chunks WHERE crawl_id = $1::uuid AND id = ANY($2::bigint[])`,
      seeded.own.crawlId,
      [...new Set(ids)],
    );
    expect(Number(found?.count ?? 0)).toBe(new Set(ids).size);
  });

  it("ranks the site's biggest content gaps for the recommendations engine", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");
    await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    const block = (crawl.analysis as { retrievability?: Record<string, unknown> }).retrievability;
    const gaps = block?.["topGaps"] as Array<Record<string, unknown>>;

    expect(gaps.length).toBeGreaterThan(0);
    // Careers is the one subject the fixture says nothing about at all.
    expect(gaps.some((gap) => gap["topicLabel"] === "Careers and hiring")).toBe(true);
    expect(gaps.every((gap) => gap["answered"] !== "fully")).toBe(true);
  });

  it("serves the per-question detail through the analysis endpoint", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");
    await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });
    await prisma.crawl.update({
      where: { id: seeded.own.crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const analysis = await getAnalysis(
      { projects: new ProjectsRepo(prisma), crawls },
      seeded.projectId,
      seeded.userId,
      seeded.own.crawlId,
    );

    if (!analysis.ok) throw analysis.error;
    expect(analysis.value.retrievability).not.toBeNull();
    expect(analysis.value.retrievability?.questions.length).toBeGreaterThan(0);
    expect(analysis.value.retrievability?.questionsTotal).toBe(
      analysis.value.retrievability?.questions.length,
    );
  });
});

describe("degradation", () => {
  it("null-flags the component when the judge is unavailable, and never invents a score", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");

    const result = await simulateRetrievability(retrievabilityDeps(judgeOutage()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    expect(result.ok).toBe(false);
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    expect((crawl.analysis as { retrievability?: unknown }).retrievability).toEqual({
      available: false,
      reason: "judge_unavailable",
    });
  });

  it("still completes the crawl, degraded, after a judge outage", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");
    await simulateRetrievability(retrievabilityDeps(judgeOutage()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    const finalized = await aggregateCrawl(
      { crawls, chunks, events, progress, log },
      { crawlId: seeded.own.crawlId, projectId: seeded.projectId },
    );

    if (!finalized.ok) throw finalized.error;
    expect(finalized.value.status).toBe("COMPLETED_DEGRADED");
    expect(finalized.value.degradation).toMatchObject({ retrievability: "judge_unavailable" });
    expect(finalized.value.finishedAt).not.toBeNull();
  });

  it("serves retrievability as null, not as zero, once degraded", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");
    await simulateRetrievability(retrievabilityDeps(judgeOutage()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });
    await aggregateCrawl(
      { crawls, chunks, events, progress, log },
      { crawlId: seeded.own.crawlId, projectId: seeded.projectId },
    );

    const analysis = await getAnalysis(
      { projects: new ProjectsRepo(prisma), crawls },
      seeded.projectId,
      seeded.userId,
      seeded.own.crawlId,
    );

    if (!analysis.ok) throw analysis.error;
    // Null is "we could not measure this". Zero would be a claim about their content.
    expect(analysis.value.retrievability).toBeNull();
    expect(analysis.value.degradation).toMatchObject({ retrievability: "judge_unavailable" });
  });

  it("refuses without a taxonomy rather than scoring nothing as zero", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES, "acme.com");
    await indexPages(
      { gateway: buildGateway(new SubjectAdapter()), chunks, crawls, log },
      {
        crawlId: seeded.own.crawlId,
        projectId: seeded.projectId,
        snapshotIds: seeded.own.snapshotIds,
      },
    );

    const result = await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    expect(result.ok).toBe(false);
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    expect((crawl.analysis as { retrievability?: unknown }).retrievability).toEqual({
      available: false,
      reason: "no_taxonomy",
    });
  });

  it("refuses without vectors rather than silently measuring something else", async () => {
    const seeded = await seedProject(prisma, OWN_PAGES, "acme.com");
    const created = await topics.replaceGenerated(
      seeded.projectId,
      TAXONOMY.map((topic, position) => ({
        label: topic.label,
        description: topic.description,
        source: "GENERATED" as const,
        position,
      })),
    );
    expect(created.length).toBeGreaterThan(0);

    // Chunks exist with their tsvectors, but no embeddings: lexical-only retrieval would
    // be a different measurement wearing the same name.
    const noEmbeddings: ProviderAdapter = {
      name: "fake",
      complete: (request) => new FakeAdapter().complete(request),
      embed: async () => {
        throw new Error("embedding provider down");
      },
    };
    await indexPages(
      { gateway: buildGateway(noEmbeddings), chunks, crawls, log },
      {
        crawlId: seeded.own.crawlId,
        projectId: seeded.projectId,
        snapshotIds: seeded.own.snapshotIds,
      },
    );

    const result = await simulateRetrievability(retrievabilityDeps(new SubjectAdapter()), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    expect(result.ok).toBe(false);
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.own.crawlId } });
    expect((crawl.analysis as { retrievability?: unknown }).retrievability).toEqual({
      available: false,
      reason: "no_embeddings",
    });
  });

  it("survives a judge that fails intermittently, as long as enough questions land", async () => {
    const seeded = await seedIndexed(OWN_PAGES, "acme.com");
    let judgeCalls = 0;
    const flaky: ProviderAdapter = {
      name: "fake",
      complete: async (request) => {
        if (request.system.toLowerCase().includes("judge")) {
          judgeCalls += 1;
          // One in ten fails outright — comfortably inside the 70% threshold.
          if (judgeCalls % 10 === 0) throw new Error("transient judge failure");
        }
        return new SubjectAdapter().complete(request);
      },
      embed: (request) => new SubjectAdapter().embed(request),
    };

    const result = await simulateRetrievability(retrievabilityDeps(flaky), {
      projectId: seeded.projectId,
      crawlId: seeded.own.crawlId,
      siteId: seeded.own.siteId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questionsJudged).toBeLessThan(result.value.questionsTotal);
    expect(result.value.judgedShare).toBeGreaterThanOrEqual(RETRIEVABILITY_V1.minJudgedShare);
    expect(result.value.score).not.toBeNull();
  });
});
