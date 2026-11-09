/**
 * The database-constraint suite (Engineering-Rules §9: merge-blocking, never skipped).
 *
 * These invariants are the ones the product cannot be wrong about, so they are enforced by
 * Postgres rather than by application checks — a code bug cannot violate them. Each test
 * proves the constraint fires, not that some service remembered to look.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;

const UNIQUE_VIOLATION = "P2002";

async function seedProject(): Promise<{ userId: string; projectId: string; siteId: string }> {
  const user = await prisma.user.create({
    data: { email: `owner-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: "Constraint fixture" },
  });
  const site = await prisma.site.create({
    data: {
      projectId: project.id,
      url: "https://example.test",
      domain: "example.test",
      role: "OWN",
    },
  });
  return { userId: user.id, projectId: project.id, siteId: site.id };
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

describe("one OWN site per project", () => {
  it("rejects a second OWN site", async () => {
    const { projectId } = await seedProject();
    await expect(
      prisma.site.create({
        data: {
          projectId,
          url: "https://second.test",
          domain: "second.test",
          role: "OWN",
        },
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it("allows competitors alongside the OWN site", async () => {
    const { projectId } = await seedProject();
    const competitor = await prisma.site.create({
      data: {
        projectId,
        url: "https://rival.test",
        domain: "rival.test",
        role: "COMPETITOR",
      },
    });
    expect(competitor.role).toBe("COMPETITOR");
  });

  it("rejects the same URL twice within a project", async () => {
    const { projectId } = await seedProject();
    await expect(
      prisma.site.create({
        data: {
          projectId,
          url: "https://example.test",
          domain: "example.test",
          role: "COMPETITOR",
        },
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });
});

describe("one active crawl per site", () => {
  it.each(["QUEUED", "CRAWLING", "ANALYZING"] as const)(
    "rejects a second crawl while one is %s",
    async (status) => {
      const { projectId, siteId } = await seedProject();
      await prisma.crawl.create({ data: { siteId, projectId, status, trigger: "MANUAL" } });
      await expect(
        prisma.crawl.create({ data: { siteId, projectId, status: "QUEUED", trigger: "MANUAL" } }),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    },
  );

  it.each(["COMPLETED", "COMPLETED_DEGRADED", "FAILED", "CANCELED"] as const)(
    "allows a new crawl once the previous one is %s",
    async (status) => {
      const { projectId, siteId } = await seedProject();
      await prisma.crawl.create({ data: { siteId, projectId, status, trigger: "MANUAL" } });
      const next = await prisma.crawl.create({
        data: { siteId, projectId, status: "QUEUED", trigger: "SCHEDULED" },
      });
      expect(next.status).toBe("QUEUED");
    },
  );
});

describe("one active prompt run per project", () => {
  it("rejects a second QUEUED run", async () => {
    const { projectId } = await seedProject();
    await prisma.promptRun.create({
      data: { projectId, trigger: "MANUAL", status: "RUNNING", engines: ["perplexity"] },
    });
    await expect(
      prisma.promptRun.create({
        data: { projectId, trigger: "MANUAL", status: "QUEUED", engines: ["perplexity"] },
      }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });
});

describe("scores", () => {
  it("rejects a score with neither a crawl nor a prompt run", async () => {
    const { projectId } = await seedProject();
    await expect(
      prisma.score.create({
        data: { projectId, composite: 50, components: {}, scoringConfigVersion: "v1" },
      }),
    ).rejects.toThrow(/scores_have_input/);
  });

  it("rejects a composite outside 0–100", async () => {
    const { projectId, siteId } = await seedProject();
    const crawl = await prisma.crawl.create({
      data: { siteId, projectId, status: "COMPLETED", trigger: "MANUAL" },
    });
    await expect(
      prisma.score.create({
        data: {
          projectId,
          crawlId: crawl.id,
          composite: 101,
          components: {},
          scoringConfigVersion: "v1",
        },
      }),
    ).rejects.toThrow(/scores_ranges/);
  });

  it("rejects a component score outside 0–100", async () => {
    const { projectId, siteId } = await seedProject();
    const crawl = await prisma.crawl.create({
      data: { siteId, projectId, status: "COMPLETED", trigger: "MANUAL" },
    });
    await expect(
      prisma.score.create({
        data: {
          projectId,
          crawlId: crawl.id,
          composite: 50,
          scoreCitation: -1,
          components: {},
          scoringConfigVersion: "v1",
        },
      }),
    ).rejects.toThrow(/scores_ranges/);
  });

  it("accepts a crawl-only score with null components", async () => {
    const { projectId, siteId } = await seedProject();
    const crawl = await prisma.crawl.create({
      data: { siteId, projectId, status: "COMPLETED", trigger: "MANUAL" },
    });
    const score = await prisma.score.create({
      data: {
        projectId,
        crawlId: crawl.id,
        composite: 50,
        scoreRetrievability: 61,
        components: { citation: { value: null, reason: "unavailable_yet" } },
        scoringConfigVersion: "v1",
      },
    });
    expect(score.scoreCitation).toBeNull();
  });
});

describe("prompt result cells", () => {
  it("rejects a duplicate (run, template, engine, sample) cell", async () => {
    const { projectId } = await seedProject();
    const run = await prisma.promptRun.create({
      data: { projectId, trigger: "MANUAL", status: "RUNNING", engines: ["perplexity"] },
    });
    const template = await prisma.promptTemplate.create({
      data: { projectId, text: "best analytics tool for saas", source: "GENERATED" },
    });
    const cell = {
      promptRunId: run.id,
      promptTemplateId: template.id,
      engine: "perplexity",
      sampleIndex: 0,
      model: "sonar",
    };
    await prisma.promptResult.create({ data: cell });
    await expect(prisma.promptResult.create({ data: cell })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it("allows the same prompt on a different engine or sample", async () => {
    const { projectId } = await seedProject();
    const run = await prisma.promptRun.create({
      data: { projectId, trigger: "MANUAL", status: "RUNNING", engines: ["perplexity", "openai"] },
    });
    const template = await prisma.promptTemplate.create({
      data: { projectId, text: "best analytics tool for saas", source: "GENERATED" },
    });
    const base = { promptRunId: run.id, promptTemplateId: template.id, model: "sonar" };
    await prisma.promptResult.create({ data: { ...base, engine: "perplexity", sampleIndex: 0 } });
    await prisma.promptResult.create({ data: { ...base, engine: "perplexity", sampleIndex: 1 } });
    await prisma.promptResult.create({ data: { ...base, engine: "openai", sampleIndex: 0 } });
    expect(await prisma.promptResult.count({ where: { promptRunId: run.id } })).toBe(3);
  });

  it("refuses to delete a template that still has results (evidence must survive)", async () => {
    const { projectId } = await seedProject();
    const run = await prisma.promptRun.create({
      data: { projectId, trigger: "MANUAL", status: "COMPLETED", engines: ["perplexity"] },
    });
    const template = await prisma.promptTemplate.create({
      data: { projectId, text: "who is the best at ai visibility", source: "USER" },
    });
    await prisma.promptResult.create({
      data: {
        promptRunId: run.id,
        promptTemplateId: template.id,
        engine: "perplexity",
        sampleIndex: 0,
        model: "sonar",
      },
    });
    await expect(prisma.promptTemplate.delete({ where: { id: template.id } })).rejects.toThrow();
  });
});

describe("expression uniques", () => {
  it("rejects two active topics whose labels differ only by case", async () => {
    const { projectId } = await seedProject();
    await prisma.topic.create({ data: { projectId, label: "Pricing Pages", source: "GENERATED" } });
    await expect(
      prisma.topic.create({ data: { projectId, label: "pricing pages", source: "USER" } }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it("allows the label again once the first topic is archived", async () => {
    const { projectId } = await seedProject();
    const first = await prisma.topic.create({
      data: { projectId, label: "Pricing Pages", source: "GENERATED" },
    });
    await prisma.topic.update({ where: { id: first.id }, data: { status: "ARCHIVED" } });
    const second = await prisma.topic.create({
      data: { projectId, label: "pricing pages", source: "USER" },
    });
    expect(second.status).toBe("ACTIVE");
  });

  it("rejects a duplicate active prompt text", async () => {
    const { projectId } = await seedProject();
    const text = "which tool is best for tracking ai citations";
    await prisma.promptTemplate.create({ data: { projectId, text, source: "GENERATED" } });
    await expect(
      prisma.promptTemplate.create({ data: { projectId, text, source: "USER" } }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });
});

describe("range checks", () => {
  it("rejects coverage outside 0–100", async () => {
    const { projectId, siteId } = await seedProject();
    const crawl = await prisma.crawl.create({
      data: { siteId, projectId, status: "COMPLETED", trigger: "MANUAL" },
    });
    const topic = await prisma.topic.create({
      data: { projectId, label: "Integrations", source: "GENERATED" },
    });
    await expect(
      prisma.topicCoverage.create({
        data: { crawlId: crawl.id, topicId: topic.id, coverageScore: 140, depthChunks: 3 },
      }),
    ).rejects.toThrow(/coverage_range/);
  });

  it("rejects impact or difficulty outside 1–5", async () => {
    const { projectId } = await seedProject();
    await expect(
      prisma.recommendation.create({
        data: {
          projectId,
          fingerprint: "rule:blocked-bots:gptbot",
          source: "RULE",
          title: "Unblock GPTBot",
          body: "Remove the Disallow rule.",
          priority: "CRITICAL",
          impact: 9,
          difficulty: 1,
          evidence: {},
        },
      }),
    ).rejects.toThrow(/rec_effort_ranges/);
  });

  it("rejects two recommendations sharing a fingerprint (dedupe backstop)", async () => {
    const { projectId } = await seedProject();
    const data = {
      projectId,
      fingerprint: "rule:no-llms-txt",
      source: "RULE" as const,
      title: "Add llms.txt",
      body: "Publish an llms.txt at the site root.",
      priority: "HIGH" as const,
      impact: 3,
      difficulty: 1,
      evidence: {},
    };
    await prisma.recommendation.create({ data });
    await expect(prisma.recommendation.create({ data })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });
});

describe("deletion policy", () => {
  it("keeps ai_usage rows when a project is deleted (financial ledger)", async () => {
    const { projectId } = await seedProject();
    await prisma.aiUsage.create({
      data: {
        projectId,
        purpose: "taxonomy",
        provider: "openai",
        model: "seed-model",
        costUsdMicros: 1_234n,
      },
    });
    await prisma.project.delete({ where: { id: projectId } });
    const surviving = await prisma.aiUsage.findMany();
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.projectId).toBeNull();
  });

  it("cascades owned children when a project is deleted", async () => {
    const { projectId, siteId } = await seedProject();
    await prisma.crawl.create({
      data: { siteId, projectId, status: "COMPLETED", trigger: "MANUAL" },
    });
    await prisma.project.delete({ where: { id: projectId } });
    expect(await prisma.crawl.count()).toBe(0);
    expect(await prisma.site.count()).toBe(0);
  });
});
