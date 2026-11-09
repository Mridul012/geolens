/**
 * The gateway's guarantees, against a real ledger (M9 acceptance): every call metered with
 * purpose and cost, one repair retry then a typed failure, and budget exhaustion that
 * degrades rather than crashing.
 *
 * The provider is a scripted adapter — the thing under test is the gateway, not somebody
 * else's HTTP client.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import { FakeAdapter } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import { ProviderError } from "../../../src/infrastructure/ai/adapters/provider.js";
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  ProviderAdapter,
} from "../../../src/infrastructure/ai/adapters/provider.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { tierConfigFor } from "../../../src/config/model-tiers.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let usage: AiUsageRepo;

const logger = pino({ level: "silent" });
const schema = z.object({ answer: z.string(), score: z.number().int().min(0).max(100) });

/** An adapter that replays a scripted list of responses, one per call. */
class ScriptedAdapter implements ProviderAdapter {
  readonly name = "fake";
  readonly calls: CompletionRequest[] = [];
  #index = 0;

  constructor(private readonly script: ReadonlyArray<string | Error>) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request);
    const next = this.script[this.#index] ?? this.script.at(-1);
    this.#index += 1;
    if (next instanceof Error) throw next;
    return {
      text: next ?? "",
      usage: { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0 },
      citations: [],
    };
  }

  async embed(): Promise<EmbeddingResult> {
    return { vectors: [], inputTokens: 0 };
  }
}

function buildGateway(
  adapter: ProviderAdapter,
  limits = { perCrawlMicros: 500_000n, perRunMicros: 300_000n },
): ProviderGateway {
  return new ProviderGateway({
    // Live config so real cost arithmetic runs; the adapter is what is substituted.
    config: tierConfigFor("live"),
    adapters: { anthropic: adapter, openai: adapter, groq: adapter, perplexity: adapter },
    usage,
    budget: new BudgetGuard(usage, limits),
    tracer: createLoggingTracer(logger),
  });
}

async function seedCrawl(): Promise<{ projectId: string; crawlId: string }> {
  const user = await prisma.user.create({
    data: { email: `gw-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Gateway" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: { siteId: site.id, projectId: project.id, status: "ANALYZING", trigger: "MANUAL" },
  });
  return { projectId: project.id, crawlId: crawl.id };
}

const request = (context: { projectId: string; crawlId: string }) => ({
  tier: "frontier" as const,
  promptId: "test/v1",
  systemPrompt: "You are a test.",
  userPrompt: "Answer.",
  schema,
  context: { purpose: "test-purpose", ...context },
});

beforeAll(() => {
  prisma = createTestPrisma();
  usage = new AiUsageRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("metering", () => {
  it("writes an ai_usage row with purpose, model and cost for every call", async () => {
    const seeded = await seedCrawl();
    const gateway = buildGateway(new ScriptedAdapter(['{"answer":"yes","score":80}']));

    const result = await gateway.structured(request(seeded));
    expect(result.ok).toBe(true);

    const rows = await prisma.aiUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "test-purpose",
      provider: "anthropic",
      projectId: seeded.projectId,
      crawlId: seeded.crawlId,
      inputTokens: 1_000,
      outputTokens: 500,
    });
    // Real arithmetic at the frontier tier's rates, in integer micro-USD.
    expect(rows[0]?.costUsdMicros).toBe(10_500n);
    expect(rows[0]?.latencyMs).not.toBeNull();
  });

  it("attributes cost to the crawl so the budget can read it back", async () => {
    const seeded = await seedCrawl();
    const gateway = buildGateway(new ScriptedAdapter(['{"answer":"yes","score":80}']));

    await gateway.structured(request(seeded));
    await gateway.structured(request(seeded));

    expect(await usage.totalForCrawl(seeded.crawlId)).toBe(21_000n);
    expect(await usage.countsByPurpose(seeded.crawlId)).toEqual({ "test-purpose": 2 });
  });

  it("meters a failed call too — a rejected response still cost money", async () => {
    const seeded = await seedCrawl();
    const gateway = buildGateway(new ScriptedAdapter(["not json", "still not json"]));

    const result = await gateway.structured(request(seeded));
    expect(result.ok).toBe(false);

    // Two attempts, two ledger rows: "how much did that crawl cost" stays honest.
    expect(await prisma.aiUsage.count()).toBe(2);
  });
});

describe("structured output", () => {
  it("returns validated output on a clean first attempt", async () => {
    const seeded = await seedCrawl();
    const adapter = new ScriptedAdapter(['{"answer":"yes","score":80}']);
    const gateway = buildGateway(adapter);

    const result = await gateway.structured(request(seeded));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toEqual({ answer: "yes", score: 80 });
    expect(result.value.repaired).toBe(false);
    expect(adapter.calls).toHaveLength(1);
  });

  it("repairs once and reports that it did", async () => {
    const seeded = await seedCrawl();
    const adapter = new ScriptedAdapter([
      '{"answer":"yes"}', // missing `score`
      '{"answer":"yes","score":80}',
    ]);
    const gateway = buildGateway(adapter);

    const result = await gateway.structured(request(seeded));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repaired).toBe(true);
    expect(adapter.calls).toHaveLength(2);
    // The repair prompt names the failure rather than resending the original.
    expect(adapter.calls[1]?.user).toContain("did not match the required schema");
    expect(adapter.calls[1]?.user).toContain("score");
  });

  it("gives up after exactly one repair — never a third attempt", async () => {
    const seeded = await seedCrawl();
    const adapter = new ScriptedAdapter(['{"answer":"yes"}', '{"answer":"still no score"}']);
    const gateway = buildGateway(adapter);

    const result = await gateway.structured(request(seeded));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEGRADED");
    expect(result.error.detail).toContain("does not match its schema");
    expect(adapter.calls).toHaveLength(2);
  });

  it("never guesses at unparseable output", async () => {
    const seeded = await seedCrawl();
    const gateway = buildGateway(
      new ScriptedAdapter(["I'm sorry, I can't help with that.", "Still no."]),
    );

    const result = await gateway.structured(request(seeded));
    expect(result.ok).toBe(false);
  });

  it("unwraps a fenced response without counting it as a repair", async () => {
    const seeded = await seedCrawl();
    const adapter = new ScriptedAdapter(['```json\n{"answer":"yes","score":80}\n```']);
    const gateway = buildGateway(adapter);

    const result = await gateway.structured(request(seeded));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repaired).toBe(false);
    expect(adapter.calls).toHaveLength(1);
  });

  it("degrades on a provider failure rather than throwing", async () => {
    const seeded = await seedCrawl();
    const gateway = buildGateway(
      new ScriptedAdapter([new ProviderError("anthropic", "503 upstream", { retryable: true })]),
    );

    const result = await gateway.structured(request(seeded));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEGRADED");
    expect(result.error.detail).toContain("503 upstream");
  });

  it("degrades when no adapter is configured for the tier's provider", async () => {
    const seeded = await seedCrawl();
    const gateway = new ProviderGateway({
      config: tierConfigFor("live"),
      adapters: {},
      usage,
      budget: new BudgetGuard(usage, { perCrawlMicros: 500_000n, perRunMicros: 300_000n }),
      tracer: createLoggingTracer(logger),
    });

    const result = await gateway.structured(request(seeded));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain("No adapter configured");
  });
});

describe("budgets", () => {
  it("refuses a call once the crawl's budget is spent, without crashing", async () => {
    const seeded = await seedCrawl();
    // One frontier call costs 10,500 micro-USD. The pre-check refuses once spend has
    // *reached* the ceiling, so a crawl can overshoot by at most one call — which is
    // exactly what the cost model's deliberate headroom absorbs (AI-Pipeline §7).
    const gateway = buildGateway(new ScriptedAdapter(['{"answer":"yes","score":80}']), {
      perCrawlMicros: 10_000n,
      perRunMicros: 300_000n,
    });

    const first = await gateway.structured(request(seeded));
    expect(first.ok).toBe(true);

    const second = await gateway.structured(request(seeded));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("DEGRADED");
    expect(second.error.detail).toContain("Budget exhausted");

    // The refused call was never sent, so it cost nothing.
    expect(await prisma.aiUsage.count()).toBe(1);
  });

  it("reads spend already in the ledger, so a retried job cannot double-spend", async () => {
    const seeded = await seedCrawl();
    await usage.record({
      projectId: seeded.projectId,
      crawlId: seeded.crawlId,
      purpose: "earlier-attempt",
      provider: "anthropic",
      model: "x",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsdMicros: 20_000n,
      latencyMs: 1,
    });

    // A fresh guard, as a retried job would have.
    const gateway = buildGateway(new ScriptedAdapter(['{"answer":"y","score":1}']), {
      perCrawlMicros: 15_000n,
      perRunMicros: 300_000n,
    });

    const result = await gateway.structured(request(seeded));
    expect(result.ok).toBe(false);
  });

  it("leaves an unscoped call alone", async () => {
    const gateway = buildGateway(new ScriptedAdapter(['{"answer":"y","score":1}']), {
      perCrawlMicros: 1n,
      perRunMicros: 1n,
    });

    const result = await gateway.structured({
      tier: "frontier",
      promptId: "test/v1",
      systemPrompt: "s",
      userPrompt: "u",
      schema,
      context: { purpose: "unscoped" },
    });

    expect(result.ok).toBe(true);
  });
});

describe("embeddings", () => {
  it("batches, meters, and returns one vector per input", async () => {
    const seeded = await seedCrawl();
    const gateway = new ProviderGateway({
      config: tierConfigFor("fake"),
      adapters: { fake: new FakeAdapter() },
      usage,
      budget: new BudgetGuard(usage, { perCrawlMicros: 500_000n, perRunMicros: 300_000n }),
      tracer: createLoggingTracer(logger),
    });

    const inputs = Array.from({ length: 300 }, (_unused, index) => `chunk ${index}`);
    const result = await gateway.embed({
      inputs,
      context: { purpose: "indexing", ...seeded },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectors).toHaveLength(300);
    expect(result.value.dimensions).toBe(1_536);
    expect(result.value.vectors[0]).toHaveLength(1_536);
    expect(await prisma.aiUsage.count()).toBe(1);
  });

  it("returns an empty result for no inputs without calling a provider", async () => {
    const gateway = buildGateway(new ScriptedAdapter([]));
    const result = await gateway.embed({ inputs: [], context: { purpose: "indexing" } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectors).toEqual([]);
    expect(await prisma.aiUsage.count()).toBe(0);
  });
});

describe("the fake adapter", () => {
  it("is deterministic — the same prompt yields the same answer", async () => {
    const adapter = new FakeAdapter();
    const first = await adapter.complete({
      model: "fake",
      system: "You are a B2B market analyst producing a taxonomy.",
      user: "acme.com",
      temperature: 0,
      maxOutputTokens: 4_096,
      jsonMode: true,
      cacheSystemPrompt: false,
      timeoutMs: 1_000,
    });
    const second = await adapter.complete({
      model: "fake",
      system: "You are a B2B market analyst producing a taxonomy.",
      user: "acme.com",
      temperature: 0,
      maxOutputTokens: 4_096,
      jsonMode: true,
      cacheSystemPrompt: false,
      timeoutMs: 1_000,
    });

    expect(first.text).toBe(second.text);
  });

  it("produces schema-valid taxonomy output, so the real validation path runs", async () => {
    const { taxonomyOutputSchema } = await import("../../../src/contracts/ai/taxonomy.js");
    const adapter = new FakeAdapter();
    const completion = await adapter.complete({
      model: "fake",
      system: "You are a B2B market analyst. Produce the taxonomy.",
      user: "acme.com",
      temperature: 0,
      maxOutputTokens: 4_096,
      jsonMode: true,
      cacheSystemPrompt: false,
      timeoutMs: 1_000,
    });

    const parsed = taxonomyOutputSchema.safeParse(JSON.parse(completion.text));
    expect(parsed.success).toBe(true);
  });

  it("embeds deterministically, as unit vectors", async () => {
    const adapter = new FakeAdapter();
    const a = await adapter.embed({ model: "fake", inputs: ["hello"], timeoutMs: 1_000 });
    const b = await adapter.embed({ model: "fake", inputs: ["hello"], timeoutMs: 1_000 });

    expect(a.vectors[0]).toEqual(b.vectors[0]);
    const magnitude = Math.sqrt((a.vectors[0] ?? []).reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });
});
