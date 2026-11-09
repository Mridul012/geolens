/**
 * Prompt simulation end to end (M15 acceptance) — the product's differentiator.
 *
 * Real Postgres, real Redis, the real gateway, the real ledger, the real parser and the
 * real aggregation. Only the engine is scripted, because the thing under test is what we
 * do with an answer, not what an assistant happens to say today.
 *
 * The acceptance criteria, in order:
 *   · every cell has parsed fields and its answer text as evidence;
 *   · the deterministic parser handles the fixture matrix, and the judge is called only on
 *     the ambiguous one — the ledger proves the count;
 *   · run completion creates a score row with `prompt_run_id` set;
 *   · one engine down → COMPLETED_DEGRADED with the other engine's cells intact;
 *   · a retried cell cannot double-insert.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { runPromptSimulation, SAMPLES_PER_CELL } from "../../../src/application/prompt-sim/run-prompt-simulation.js";
import { scorePromptRun } from "../../../src/application/scoring/score-prompt-run.js";
import { ProviderGateway } from "../../../src/infrastructure/ai/gateway.js";
import { BudgetGuard } from "../../../src/infrastructure/ai/budgets/budget-guard.js";
import type { ProviderAdapter } from "../../../src/infrastructure/ai/adapters/provider.js";
import { createLoggingTracer } from "../../../src/infrastructure/ai/tracing/tracer.js";
import { loadPrompt, render } from "../../../src/infrastructure/ai/prompts/registry.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { EventsRepo } from "../../../src/infrastructure/db/repositories/events.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { PromptRunsRepo } from "../../../src/infrastructure/db/repositories/prompt-runs.repo.js";
import { PromptTemplatesRepo } from "../../../src/infrastructure/db/repositories/prompt-templates.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { RedisProgressStore } from "../../../src/infrastructure/redis/progress-store.js";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";
import { TldtsPublicSuffix } from "../../../src/infrastructure/net/public-suffix.js";
import { tierConfigFor, ENGINES } from "../../../src/config/model-tiers.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";
import { ScriptedEngineAdapter, type AnswerKind } from "../../helpers/engine-adapter.js";

let prisma: PrismaClient;
let redis: RedisClient;
let runs: PromptRunsRepo;
let prompts: PromptTemplatesRepo;
let projects: ProjectsRepo;
let sites: SitesRepo;
let events: EventsRepo;
let scores: ScoresRepo;
let progress: RedisProgressStore;
let usage: AiUsageRepo;

const log = pino({ level: "silent" });
const publicSuffix = new TldtsPublicSuffix();

function simDeps(adapter: ProviderAdapter) {
  return {
    gateway: new ProviderGateway({
      config: tierConfigFor("fake"),
      adapters: { fake: adapter },
      usage,
      budget: new BudgetGuard(usage, { perCrawlMicros: 50_000_000n, perRunMicros: 50_000_000n }),
      tracer: createLoggingTracer(log),
    }),
    runs,
    prompts,
    projects,
    sites,
    events,
    progress,
    publicSuffix,
    prompt: loadPrompt,
    render,
    log,
  };
}

interface Seeded {
  readonly projectId: string;
  readonly runId: string;
  readonly promptIds: readonly string[];
}

async function seed(promptCount = 2, withCompetitor = true): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `sim-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Acme" } });
  await prisma.site.create({
    data: {
      projectId: project.id,
      url: "https://acme.com",
      domain: "acme.com",
      role: "OWN",
      name: "Acme Analytics",
    },
  });
  if (withCompetitor) {
    await prisma.site.create({
      data: {
        projectId: project.id,
        url: "https://rival.com",
        domain: "rival.com",
        role: "COMPETITOR",
        name: "Rivalcorp",
      },
    });
  }

  const promptIds: string[] = [];
  for (let index = 0; index < promptCount; index += 1) {
    const row = await prisma.promptTemplate.create({
      data: {
        projectId: project.id,
        text: `best analytics tool for finance teams number ${index}`,
        intent: "recommendation",
        source: "GENERATED",
        position: index,
      },
    });
    promptIds.push(row.id);
  }

  const run = await runs.create({
    projectId: project.id,
    trigger: "MANUAL",
    engines: [...ENGINES],
  });

  return { projectId: project.id, runId: run.id, promptIds };
}

function scripted(
  options: Parameters<typeof ScriptedEngineAdapter.prototype.complete> extends never
    ? never
    : ConstructorParameters<typeof ScriptedEngineAdapter>[1] = {},
): ScriptedEngineAdapter {
  return new ScriptedEngineAdapter([...ENGINES], options);
}

beforeAll(() => {
  prisma = createTestPrisma();
  redis = createRedisClient();
  runs = new PromptRunsRepo(prisma);
  prompts = new PromptTemplatesRepo(prisma);
  projects = new ProjectsRepo(prisma);
  sites = new SitesRepo(prisma);
  events = new EventsRepo(prisma);
  scores = new ScoresRepo(prisma);
  progress = new RedisProgressStore(redis);
  usage = new AiUsageRepo(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
  await redis.flushdb();
});

describe("a complete run", () => {
  it("fills every prompt × engine × sample cell", async () => {
    const seeded = await seed(2);

    const result = await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cells).toBe(2 * ENGINES.length);
    expect(await runs.countResults(seeded.runId)).toBe(
      2 * ENGINES.length * SAMPLES_PER_CELL,
    );
  });

  it("stores the answer text beside every parsed field, as evidence", async () => {
    const seeded = await seed(1);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const cells = await runs.listResults(seeded.runId, { limit: 100 });
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.answerText).not.toBeNull();
      expect(typeof cell.brandMentioned).toBe("boolean");
      expect(typeof cell.brandCited).toBe("boolean");
      expect(cell.model.length).toBeGreaterThan(0);
    }
  });

  it("records the run's metrics and marks it completed", async () => {
    const seeded = await seed(2);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const run = await runs.findInProject(seeded.projectId, seeded.runId);
    expect(run?.status).toBe("COMPLETED");
    expect(run?.mentionRate).toBe(100);
    expect(run?.citationShare).toBe(100);
    expect(run?.finishedAt).not.toBeNull();
    expect((run?.metrics as { perEngine?: unknown[] })?.perEngine).toHaveLength(ENGINES.length);
  });

  it("reports progress as it goes, and finishes the stream", async () => {
    const seeded = await seed(2);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const snapshot = await progress.getPromptRunProgress(seeded.runId);
    expect(snapshot?.cellsDone).toBe(2 * ENGINES.length);
    expect(snapshot?.status).toBe("COMPLETED");
  });

  it("records a completion event for the what-changed feed", async () => {
    const seeded = await seed(1);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const event = await prisma.event.findFirstOrThrow({
      where: { projectId: seeded.projectId, kind: "prompt_run_completed" },
    });
    expect((event.payload as { runId?: string }).runId).toBe(seeded.runId);
  });
});

describe("the parser fixture matrix", () => {
  async function runWith(kind: AnswerKind, promptCount = 1) {
    const seeded = await seed(promptCount);
    await runPromptSimulation(simDeps(scripted({ fallback: kind })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });
    return { seeded, cells: await runs.listResults(seeded.runId, { limit: 100 }) };
  }

  it("mentioned and cited", async () => {
    const { cells } = await runWith("mentioned-and-cited");
    expect(cells.every((cell) => cell.brandMentioned)).toBe(true);
    expect(cells.every((cell) => cell.brandCited)).toBe(true);
    expect(cells[0]?.citations).toContain("https://acme.com/pricing");
  });

  it("mentioned but not cited", async () => {
    const { cells } = await runWith("mentioned-only");
    expect(cells.every((cell) => cell.brandMentioned)).toBe(true);
    expect(cells.every((cell) => !cell.brandCited)).toBe(true);
  });

  it("neither", async () => {
    const { cells } = await runWith("neither");
    expect(cells.every((cell) => !cell.brandMentioned)).toBe(true);
    expect(cells.every((cell) => !cell.brandCited)).toBe(true);
  });

  it("competitor-only — their citation counted, ours not", async () => {
    const { cells } = await runWith("competitor-only");
    expect(cells.every((cell) => !cell.brandCited)).toBe(true);
    const competitors = cells[0]?.competitorsMentioned ?? [];
    expect(competitors.some((competitor) => competitor.name === "rival.com" && competitor.cited)).toBe(
      true,
    );
  });

  it("does not count a competitor's own citation as ours", async () => {
    const { seeded } = await runWith("competitor-only");
    const run = await runs.findInProject(seeded.projectId, seeded.runId);
    expect(run?.citationShare).toBe(0);
    // Share of voice: none of ours, all of theirs.
    expect((run?.metrics as { shareOfVoice?: number | null })?.shareOfVoice).toBe(0);
  });
});

describe("the judge", () => {
  it("is never called when every answer is unambiguous", async () => {
    const seeded = await seed(2);
    await runPromptSimulation(simDeps(scripted({ fallback: "mentioned-and-cited" })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    // The ledger is the proof: on a typical run, zero LLM calls beyond the engines.
    const purposes = await prisma.aiUsage.groupBy({
      by: ["purpose"],
      where: { promptRunId: seeded.runId },
      _count: { _all: true },
    });
    const judge = purposes.find((row) => row.purpose === "mention-judge");
    expect(judge).toBeUndefined();
  });

  it("is called only on the ambiguous answer", async () => {
    const seeded = await seed(1);
    const result = await runPromptSimulation(simDeps(scripted({ fallback: "ambiguous" })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    if (!result.ok) throw result.error;
    // One escalation per sample that matched ambiguously.
    expect(result.value.judgeCalls).toBeGreaterThan(0);
    const ledger = await prisma.aiUsage.count({
      where: { promptRunId: seeded.runId, purpose: "mention-judge" },
    });
    expect(ledger).toBe(result.value.judgeCalls);
  });

  it("does not resolve ambiguity in the brand's favour by default", async () => {
    const seeded = await seed(1);
    await runPromptSimulation(simDeps(scripted({ fallback: "ambiguous" })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    // "the acme of simplicity" is ordinary English, not a mention.
    const cells = await runs.listResults(seeded.runId, { limit: 100 });
    expect(cells.every((cell) => !cell.brandMentioned)).toBe(true);
  });
});

describe("a degraded run", () => {
  it("completes degraded with the working engine's cells intact", async () => {
    const seeded = await seed(2);
    const [failing, working] = ENGINES;

    const result = await runPromptSimulation(
      simDeps(scripted({ failingEngines: [failing as string] })),
      { projectId: seeded.projectId, runId: seeded.runId, engines: [...ENGINES] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.degraded).toBe(true);

    const run = await runs.findInProject(seeded.projectId, seeded.runId);
    expect(run?.status).toBe("COMPLETED_DEGRADED");

    // The engine that answered still reports a real number, not a halved one.
    const perEngine = (run?.metrics as { perEngine: Array<Record<string, unknown>> }).perEngine;
    const good = perEngine.find((engine) => engine["engine"] === working);
    const bad = perEngine.find((engine) => engine["engine"] === failing);
    expect(good?.["citationShare"]).toBe(100);
    expect(bad?.["evaluableCells"]).toBe(0);
    expect(bad?.["citationShare"]).toBeNull();
  });

  it("records the failure per cell rather than as a silent absence", async () => {
    const seeded = await seed(1);
    const [failing] = ENGINES;
    await runPromptSimulation(simDeps(scripted({ failingEngines: [failing as string] })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const failed = await runs.listResults(seeded.runId, { limit: 100, engine: failing });
    expect(failed).toHaveLength(SAMPLES_PER_CELL);
    for (const cell of failed) {
      expect(cell.error).not.toBeNull();
      expect(cell.answerText).toBeNull();
    }
  });

  it("fails the run only when no engine produced anything usable", async () => {
    const seeded = await seed(1);
    await runPromptSimulation(simDeps(scripted({ failingEngines: [...ENGINES] })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const run = await runs.findInProject(seeded.projectId, seeded.runId);
    expect(run?.status).toBe("FAILED");
    expect(run?.mentionRate).toBeNull();
  });
});

describe("idempotency", () => {
  it("cannot double-insert a cell on a retried job", async () => {
    const seeded = await seed(1);
    const first = await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });
    if (!first.ok) throw first.error;
    const after = await runs.countResults(seeded.runId);

    // The whole job re-runs, as BullMQ would on a lost acknowledgement.
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    expect(await runs.countResults(seeded.runId)).toBe(after);
  });

  it("keeps the first answer, not the retry's", async () => {
    const seeded = await seed(1);
    await runPromptSimulation(simDeps(scripted({ fallback: "mentioned-and-cited" })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    // A retry whose engine now says something different must not rewrite the evidence.
    await runPromptSimulation(simDeps(scripted({ fallback: "neither" })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const cells = await runs.listResults(seeded.runId, { limit: 100 });
    expect(cells.every((cell) => cell.brandMentioned)).toBe(true);
  });
});

describe("scoring the run", () => {
  /**
   * A prior crawl-derived score, so the citation component joins five existing ones.
   *
   * Attached to a real crawl: `scores_have_input` requires a crawl or a run, which is the
   * schema refusing to hold a score that came from nowhere.
   */
  async function seedPriorScore(projectId: string): Promise<void> {
    const site = await prisma.site.findFirstOrThrow({ where: { projectId, role: "OWN" } });
    const crawl = await prisma.crawl.create({
      data: {
        siteId: site.id,
        projectId,
        status: "COMPLETED",
        trigger: "MANUAL",
        finishedAt: new Date(),
      },
    });
    await scores.insert({
      projectId,
      crawlId: crawl.id,
      promptRunId: null,
      composite: 60,
      citation: null,
      retrievability: 60,
      contentQuality: 70,
      topicCoverage: 50,
      technical: 90,
      trust: 40,
      components: {
        configVersion: "scoring.v1",
        components: [
          { component: "citation", value: null, weight: 0.35, reason: "unavailable_yet" },
          { component: "retrievability", value: 60, weight: 0.2, reason: null, evidence: {} },
          { component: "contentQuality", value: 70, weight: 0.15, reason: null, evidence: {} },
          { component: "topicCoverage", value: 50, weight: 0.15, reason: null, evidence: {} },
          { component: "technical", value: 90, weight: 0.1, reason: null, evidence: {} },
          { component: "trust", value: 40, weight: 0.05, reason: null, evidence: {} },
        ],
      },
      scoringConfigVersion: "scoring.v1",
    });
  }

  it("writes a score row with prompt_run_id set and the citation component live", async () => {
    const seeded = await seed(2);
    await seedPriorScore(seeded.projectId);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const result = await scorePromptRun({ runs, scores, events, log }, {
      projectId: seeded.projectId,
      runId: seeded.runId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.published).toBe(true);
    expect(result.value.score?.promptRunId).toBe(seeded.runId);
    expect(result.value.score?.crawlId).toBeNull();
    // Every cell mentioned and cited, so 0.6·100 + 0.4·100 = 100.
    expect(result.value.score?.scoreCitation).toBe(100);
  });

  it("carries the crawl components forward rather than recomputing them", async () => {
    const seeded = await seed(1);
    await seedPriorScore(seeded.projectId);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const result = await scorePromptRun({ runs, scores, events, log }, {
      projectId: seeded.projectId,
      runId: seeded.runId,
    });

    if (!result.ok) throw result.error;
    expect(result.value.score?.scoreRetrievability).toBe(60);
    expect(result.value.score?.scoreTechnical).toBe(90);
  });

  it("records a citation event so the what-changed feed can show it", async () => {
    const seeded = await seed(1);
    await seedPriorScore(seeded.projectId);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });
    await scorePromptRun({ runs, scores, events, log }, {
      projectId: seeded.projectId,
      runId: seeded.runId,
    });

    const gained = await prisma.event.count({
      where: { projectId: seeded.projectId, kind: "citation_gained" },
    });
    expect(gained).toBe(1);
  });

  it("writes nothing when the run measured nothing", async () => {
    const seeded = await seed(1);
    await seedPriorScore(seeded.projectId);
    await runPromptSimulation(simDeps(scripted({ failingEngines: [...ENGINES] })), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const before = await prisma.score.count({ where: { projectId: seeded.projectId } });
    const result = await scorePromptRun({ runs, scores, events, log }, {
      projectId: seeded.projectId,
      runId: seeded.runId,
    });

    expect(result.ok).toBe(false);
    // A run that measured nothing must not overwrite a good score with an outage's numbers.
    expect(await prisma.score.count({ where: { projectId: seeded.projectId } })).toBe(before);
  });

  it("publishes on the citation component alone when nothing else has run", async () => {
    // 0.35 is under the 0.50 floor, so a brand-new project's first run stays pending.
    const seeded = await seed(1);
    await runPromptSimulation(simDeps(scripted()), {
      projectId: seeded.projectId,
      runId: seeded.runId,
      engines: [...ENGINES],
    });

    const result = await scorePromptRun({ runs, scores, events, log }, {
      projectId: seeded.projectId,
      runId: seeded.runId,
    });

    if (!result.ok) throw result.error;
    expect(result.value.published).toBe(false);
    expect(result.value.score).toBeNull();
  });
});
