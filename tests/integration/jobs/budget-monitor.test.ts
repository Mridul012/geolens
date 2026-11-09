/**
 * The budget monitor (M18): flags a project trending over its AI spend ceiling — an ops
 * concern, sent only to the ops alert address, never into the project's own event feed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { monitorBudgets, type BudgetMonitorDeps } from "../../../src/application/jobs/budget-monitor.js";
import { FakeMailer } from "../../../src/infrastructure/email/fake-mailer.js";
import { AiUsageRepo } from "../../../src/infrastructure/db/repositories/ai-usage.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let aiUsage: AiUsageRepo;
let mailer: FakeMailer;
let deps: BudgetMonitorDeps;

const log = pino({ level: "silent" });
const now = new Date("2026-09-06T12:00:00.000Z");
const BUDGET_MICROS = 5_000_000;

async function seedProject(name: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `budget-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name } });
  return project.id;
}

beforeAll(() => {
  prisma = createTestPrisma();
  aiUsage = new AiUsageRepo(prisma);
});

beforeEach(async () => {
  await truncateAll(prisma);
  mailer = new FakeMailer();
  deps = {
    projects: new ProjectsRepo(prisma),
    aiUsage,
    mailer,
    clock: { now: () => now },
    budgetMicros: BUDGET_MICROS,
    opsAlertEmail: "ops@vryse.example",
    log,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("monitorBudgets", () => {
  it("flags and emails a project trending over the warning ratio", async () => {
    const projectId = await seedProject("Big Spender");
    await aiUsage.record({
      projectId,
      purpose: "prompt-sim",
      provider: "fake",
      model: "fake-frontier",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsdMicros: BigInt(Math.round(BUDGET_MICROS * 0.85)),
      latencyMs: 10,
    });

    const result = await monitorBudgets(deps);

    expect(result.flagged).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain("Big Spender");
    // Never leaks into the project's own customer-visible event feed.
    expect(await prisma.event.count({ where: { projectId } })).toBe(0);
  });

  it("stays quiet for a project comfortably under budget", async () => {
    const projectId = await seedProject("Frugal");
    await aiUsage.record({
      projectId,
      purpose: "prompt-sim",
      provider: "fake",
      model: "fake-bulk",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsdMicros: 10_000n,
      latencyMs: 5,
    });

    const result = await monitorBudgets(deps);

    expect(result.flagged).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("ignores spend outside the trailing window", async () => {
    const projectId = await seedProject("Old Spend");
    await aiUsage.record({
      projectId,
      purpose: "prompt-sim",
      provider: "fake",
      model: "fake-frontier",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsdMicros: BigInt(BUDGET_MICROS),
      latencyMs: 10,
    });
    await prisma.aiUsage.updateMany({
      where: { projectId },
      data: { createdAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000) },
    });

    const result = await monitorBudgets(deps);

    expect(result.flagged).toBe(0);
  });

  it("logs but sends no email when no ops address is configured", async () => {
    await seedProject("Silent Alert");
    const projectId = await seedProject("Big Spender 2");
    await aiUsage.record({
      projectId,
      purpose: "prompt-sim",
      provider: "fake",
      model: "fake-frontier",
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsdMicros: BigInt(BUDGET_MICROS),
      latencyMs: 10,
    });

    const result = await monitorBudgets({ ...deps, opsAlertEmail: null });

    expect(result.flagged).toBe(1);
    expect(mailer.sent).toHaveLength(0);
  });
});
