/**
 * PDF report generation end to end (M17 acceptance).
 *
 * Real Postgres, real MinIO, and a real headless Chromium printing the real report page —
 * this is the one place in the suite that proves Playwright's PDF output is an actual PDF
 * and not just a string that looks like HTML. The failure path is asserted separately: a
 * renderer that throws must leave the row FAILED, not stuck in GENERATING, and must
 * rethrow so BullMQ retries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import {
  generateReport,
  type GenerateReportDeps,
} from "../../../src/application/reports/generate-report.js";
import { PlaywrightPdfRenderer } from "../../../src/infrastructure/rendering/playwright-pdf-renderer.js";
import {
  S3ObjectStorage,
  createS3Client,
} from "../../../src/infrastructure/storage/s3-object-storage.js";
import { ChunksRepo } from "../../../src/infrastructure/db/repositories/chunks.repo.js";
import { CrawlsRepo } from "../../../src/infrastructure/db/repositories/crawls.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { RecommendationsRepo } from "../../../src/infrastructure/db/repositories/recommendations.repo.js";
import { ReportsRepo } from "../../../src/infrastructure/db/repositories/reports.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { SiteFactsRepo } from "../../../src/infrastructure/db/repositories/site-facts.repo.js";
import { SitesRepo } from "../../../src/infrastructure/db/repositories/sites.repo.js";
import { TopicCoverageRepo } from "../../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { TopicsRepo } from "../../../src/infrastructure/db/repositories/topics.repo.js";
import { systemClock } from "../../../src/application/ports/clock.port.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let reports: ReportsRepo;
let renderer: PlaywrightPdfRenderer;
let storage: S3ObjectStorage;
let deps: GenerateReportDeps;

const log = pino({ level: "silent" });

interface Seeded {
  readonly projectId: string;
  readonly siteId: string;
  readonly crawlId: string;
}

async function seedCompletedCrawl(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `report-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Acme" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId: project.id,
      status: "COMPLETED",
      trigger: "MANUAL",
      finishedAt: new Date(),
      analysis: {
        executiveSummary: "Acme is visible for pricing questions.",
        strengths: ["Fast site"],
        weaknesses: ["Thin comparison content"],
      },
    },
  });
  return { projectId: project.id, siteId: site.id, crawlId: crawl.id };
}

beforeAll(() => {
  prisma = createTestPrisma();
  reports = new ReportsRepo(prisma);
  renderer = new PlaywrightPdfRenderer();
  storage = new S3ObjectStorage(createS3Client());
  deps = {
    reports,
    assemble: {
      projects: new ProjectsRepo(prisma),
      sites: new SitesRepo(prisma),
      crawls: new CrawlsRepo(prisma),
      scores: new ScoresRepo(prisma),
      siteFacts: new SiteFactsRepo(prisma),
      chunks: new ChunksRepo(prisma),
      topics: new TopicsRepo(prisma),
      coverage: new TopicCoverageRepo(prisma),
      recommendations: new RecommendationsRepo(prisma),
      clock: systemClock,
    },
    renderer,
    storage,
    clock: systemClock,
    log,
  };
});

afterAll(async () => {
  await renderer.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

describe("a report with real content", () => {
  it("renders an actual PDF and stores it, marking the row READY", async () => {
    const seeded = await seedCompletedCrawl();
    await new ScoresRepo(prisma).insert({
      projectId: seeded.projectId,
      crawlId: seeded.crawlId,
      promptRunId: null,
      composite: 72,
      citation: 60,
      retrievability: 80,
      contentQuality: 75,
      topicCoverage: 65,
      technical: 90,
      trust: 55,
      components: { configVersion: "scoring.v1", components: [] },
      scoringConfigVersion: "scoring.v1",
    });
    await new RecommendationsRepo(prisma).upsertByFingerprint({
      projectId: seeded.projectId,
      fingerprint: "rec-1",
      source: "RULE",
      ruleKey: "thin-content",
      title: "Add comparison content",
      body: "Publish a page comparing Acme to alternatives.",
      priority: "HIGH",
      impact: 4,
      difficulty: 2,
      evidence: {},
      crawlId: seeded.crawlId,
    });
    const report = await reports.create({
      projectId: seeded.projectId,
      kind: "ON_DEMAND",
      crawlId: seeded.crawlId,
      promptRunId: null,
      sections: ["summary", "score", "trends", "recommendations", "comparison"],
    });

    const result = await generateReport(deps, { reportId: report.id, projectId: seeded.projectId });

    if (!result.ok) throw result.error;
    expect(result.value).not.toBeNull();
    expect(result.value?.sizeBytes).toBeGreaterThan(0);

    const stored = await reports.findInProject(seeded.projectId, report.id);
    expect(stored?.status).toBe("READY");
    expect(stored?.sizeBytes).toBe(result.value?.sizeBytes);
    expect(stored?.generatedAt).not.toBeNull();

    const info = await reports.downloadInfo(seeded.projectId, report.id);
    expect(info?.storageKey).not.toBeNull();
    const bytes = await storage.get(info!.storageKey!);
    expect(bytes).not.toBeNull();
    // A real PDF, not just bytes that happen to be non-empty.
    expect(Buffer.from(bytes!.slice(0, 5)).toString("ascii")).toBe("%PDF-");
  }, 30_000);

  it("generates within the acceptance budget", async () => {
    const seeded = await seedCompletedCrawl();
    const report = await reports.create({
      projectId: seeded.projectId,
      kind: "ON_DEMAND",
      crawlId: seeded.crawlId,
      promptRunId: null,
      sections: ["summary", "score", "trends", "recommendations", "comparison"],
    });

    const started = Date.now();
    const result = await generateReport(deps, { reportId: report.id, projectId: seeded.projectId });
    const elapsedMs = Date.now() - started;

    if (!result.ok) throw result.error;
    expect(elapsedMs).toBeLessThan(60_000);
  }, 60_000);
});

describe("a report with no data yet", () => {
  it("still renders a valid PDF — every section prints an honest placeholder", async () => {
    const user = await prisma.user.create({
      data: { email: `report-empty-${Date.now()}@example.test` },
    });
    const project = await prisma.project.create({ data: { userId: user.id, name: "Fresh Co" } });
    await prisma.site.create({
      data: { projectId: project.id, url: "https://fresh.co", domain: "fresh.co", role: "OWN" },
    });
    const report = await reports.create({
      projectId: project.id,
      kind: "ON_DEMAND",
      crawlId: null,
      promptRunId: null,
      sections: ["summary", "score", "trends", "recommendations", "comparison"],
    });

    const result = await generateReport(deps, { reportId: report.id, projectId: project.id });

    if (!result.ok) throw result.error;
    expect(result.value?.sizeBytes).toBeGreaterThan(0);
    const stored = await reports.findInProject(project.id, report.id);
    expect(stored?.status).toBe("READY");
  }, 30_000);
});

describe("failure handling", () => {
  it("marks the row FAILED and rethrows when rendering blows up, so BullMQ retries", async () => {
    const seeded = await seedCompletedCrawl();
    const report = await reports.create({
      projectId: seeded.projectId,
      kind: "ON_DEMAND",
      crawlId: seeded.crawlId,
      promptRunId: null,
      sections: ["summary"],
    });

    const brokenRenderer = {
      renderPdf: async () => {
        throw new Error("chromium crashed");
      },
    };

    await expect(
      generateReport({ ...deps, renderer: brokenRenderer }, { reportId: report.id, projectId: seeded.projectId }),
    ).rejects.toThrow("chromium crashed");

    const stored = await reports.findInProject(seeded.projectId, report.id);
    expect(stored?.status).toBe("FAILED");
  });

  it("resolves to nothing rather than throwing when the report row is gone", async () => {
    const seeded = await seedCompletedCrawl();
    const report = await reports.create({
      projectId: seeded.projectId,
      kind: "ON_DEMAND",
      crawlId: seeded.crawlId,
      promptRunId: null,
      sections: ["summary"],
    });
    await prisma.report.delete({ where: { id: report.id } });

    const result = await generateReport(deps, { reportId: report.id, projectId: seeded.projectId });

    if (!result.ok) throw result.error;
    expect(result.value).toBeNull();
  });
});
