/**
 * Tracked prompt generation (M14 acceptance).
 *
 * Two properties matter beyond "it produces ten rows". The prompts must span buyer intents
 * — a set of ten recommendation questions measures one thing ten times — and the set must
 * never be regenerated, because a tracked prompt's whole value is the trend line behind it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { generateTrackedPrompts } from "../../../src/application/prompt-sim/generate-prompts.js";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import type { ProviderAdapter } from "../../../src/infrastructure/ai/adapters/provider.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { loadPrompt, render } from "../../../src/infrastructure/ai/prompts/registry.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { PromptTemplatesRepo } from "../../../src/infrastructure/db/repositories/prompt-templates.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { tierConfigFor } from "../../../src/config/model-tiers.js";
import { PROMPT_INTENTS } from "../../../src/contracts/ai/prompt-gen.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let crawls: CrawlsRepo;
let sites: SitesRepo;
let topics: TopicsRepo;
let prompts: PromptTemplatesRepo;
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
    prompts,
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

const TAXONOMY = [
  "Pricing and plans",
  "Security and compliance",
  "API reference",
  "Migration guides",
  "Getting started",
];

async function seed(withTaxonomy = true): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `pg-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Prompts" } });
  const site = await prisma.site.create({
    data: {
      projectId: project.id,
      url: "https://acme.com",
      domain: "acme.com",
      role: "OWN",
      name: "Acme",
    },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId: project.id,
      status: "ANALYZING",
      trigger: "MANUAL",
      analysis: { taxonomy: { available: true, niche: "AI search analytics" } },
    },
  });

  if (withTaxonomy) {
    for (const [position, label] of TAXONOMY.entries()) {
      await prisma.topic.create({
        data: {
          projectId: project.id,
          label,
          description: `What buyers need to know about ${label.toLowerCase()}.`,
          source: "GENERATED",
          position,
        },
      });
    }
  }

  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

beforeAll(() => {
  prisma = createTestPrisma();
  crawls = new CrawlsRepo(prisma);
  sites = new SitesRepo(prisma);
  topics = new TopicsRepo(prisma);
  prompts = new PromptTemplatesRepo(prisma);
  usage = new AiUsageRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("the first crawl", () => {
  it("yields ten tracked prompts", async () => {
    const seeded = await seed();

    const result = await generateTrackedPrompts(deps(), seeded);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.promptsCreated).toBe(10);

    const rows = await prompts.listForProject(seeded.projectId, "ACTIVE");
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.source === "GENERATED")).toBe(true);
    expect(rows.every((row) => row.pinned === false)).toBe(true);
  });

  it("spans more than one buyer intent", async () => {
    const seeded = await seed();
    await generateTrackedPrompts(deps(), seeded);

    const rows = await prompts.listForProject(seeded.projectId, "ACTIVE");
    const intents = new Set(rows.map((row) => row.intent));
    expect(intents.size).toBeGreaterThan(1);
    for (const intent of intents) {
      expect(PROMPT_INTENTS).toContain(intent);
    }
  });

  it("produces ten distinct prompts, not ten rewordings of one", async () => {
    const seeded = await seed();
    await generateTrackedPrompts(deps(), seeded);

    const rows = await prompts.listForProject(seeded.projectId, "ACTIVE");
    expect(new Set(rows.map((row) => row.text)).size).toBe(10);
  });

  it("builds them from the project's own taxonomy", async () => {
    const seeded = await seed();
    await generateTrackedPrompts(deps(), seeded);

    const texts = (await prompts.listForProject(seeded.projectId, "ACTIVE")).map((row) =>
      row.text.toLowerCase(),
    );
    expect(texts.some((text) => text.includes("pricing and plans"))).toBe(true);
    expect(texts.some((text) => text.includes("security and compliance"))).toBe(true);
  });

  it("numbers them densely so the UI can reorder them", async () => {
    const seeded = await seed();
    await generateTrackedPrompts(deps(), seeded);

    const positions = (await prompts.listForProject(seeded.projectId, "ACTIVE"))
      .map((row) => row.position)
      .sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 10 }, (_unused, index) => index));
  });

  it("records the block in the crawl's analysis artifact", async () => {
    const seeded = await seed();
    await generateTrackedPrompts(deps(), seeded);

    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    expect((crawl.analysis as { trackedPrompts?: unknown }).trackedPrompts).toMatchObject({
      available: true,
      promptsCreated: 10,
      promptId: "prompt-gen/v1",
    });
  });

  it("meters the call", async () => {
    const seeded = await seed();
    await generateTrackedPrompts(deps(), seeded);
    expect((await usage.countsByPurpose(seeded.crawlId))["prompt-generation"]).toBe(1);
  });
});

describe("degradation", () => {
  it("refuses without a taxonomy rather than inventing prompts", async () => {
    const seeded = await seed(false);

    const result = await generateTrackedPrompts(deps(), seeded);

    expect(result.ok).toBe(false);
    expect(await prisma.promptTemplate.count()).toBe(0);
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    expect((crawl.analysis as { trackedPrompts?: unknown }).trackedPrompts).toEqual({
      available: false,
      reason: "no_taxonomy",
    });
  });

  it("leaves the user able to add prompts by hand when generation fails", async () => {
    const seeded = await seed();
    const broken: ProviderAdapter = {
      name: "fake",
      complete: async () => ({
        text: "I cannot produce that.",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
        citations: [],
      }),
      embed: (request) => new FakeAdapter().embed(request),
    };

    const result = await generateTrackedPrompts(deps(broken), seeded);

    expect(result.ok).toBe(false);
    expect(await prisma.promptTemplate.count()).toBe(0);
    const crawl = await prisma.crawl.findUniqueOrThrow({ where: { id: seeded.crawlId } });
    expect((crawl.analysis as { trackedPrompts?: unknown }).trackedPrompts).toEqual({
      available: false,
      reason: "generation_failed",
    });
  });

  it("saves nothing when the set fails validation — never a partial nine", async () => {
    const seeded = await seed();
    const shortSet: ProviderAdapter = {
      name: "fake",
      complete: async () => ({
        text: JSON.stringify({
          prompts: [{ text: "only one prompt here", intent: "comparison" }],
        }),
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
        citations: [],
      }),
      embed: (request) => new FakeAdapter().embed(request),
    };

    const result = await generateTrackedPrompts(deps(shortSet), seeded);

    expect(result.ok).toBe(false);
    expect(await prisma.promptTemplate.count()).toBe(0);
  });
});

describe("the set is generated once", () => {
  it("does not replace prompts a project already tracks", async () => {
    const seeded = await seed();
    await generateTrackedPrompts(deps(), seeded);
    const first = await prompts.listForProject(seeded.projectId, "ACTIVE");

    // The crawl processor guards on `needsPrompts`, but the invariant is worth asserting
    // directly: a second call must not archive the set and start the trend lines over.
    const second = await generateTrackedPrompts(deps(), seeded);

    // Refused by the guard, cleanly, rather than by a constraint violation escaping as a
    // thrown error and three job retries.
    expect(second.ok).toBe(false);
    const after = await prompts.listForProject(seeded.projectId, "ACTIVE");
    expect(after.map((row) => row.id)).toEqual(first.map((row) => row.id));
  });

  it("keeps a user's own prompts alongside the generated ones", async () => {
    const seeded = await seed();
    await prisma.promptTemplate.create({
      data: {
        projectId: seeded.projectId,
        text: "a question the user added themselves",
        source: "USER",
        position: 99,
      },
    });

    await generateTrackedPrompts(deps(), seeded);

    const rows = await prompts.listForProject(seeded.projectId, "ACTIVE");
    expect(rows).toHaveLength(11);
    expect(rows.some((row) => row.source === "USER")).toBe(true);
  });
});
