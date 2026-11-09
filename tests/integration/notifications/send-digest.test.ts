/**
 * The weekly digest send (M18 acceptance): correct deltas when the week had real
 * movement, and a clean skip — no email at all — when it didn't.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { sendDigest, type SendDigestDeps } from "../../../src/application/notifications/send-digest.js";
import { FakeMailer } from "../../../src/infrastructure/email/fake-mailer.js";
import { EventsRepo } from "../../../src/infrastructure/db/repositories/events.repo.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { RecommendationsRepo } from "../../../src/infrastructure/db/repositories/recommendations.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let mailer: FakeMailer;
let scores: ScoresRepo;
let events: EventsRepo;
let recommendations: RecommendationsRepo;
let deps: SendDigestDeps;

const log = pino({ level: "silent" });
const now = new Date("2026-09-06T12:00:00.000Z");

interface Seeded {
  readonly projectId: string;
  readonly siteId: string;
}

async function seedProject(): Promise<Seeded> {
  const user = await prisma.user.create({
    data: { email: `digest-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Acme" } });
  const site = await prisma.site.create({
    data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
  });
  return { projectId: project.id, siteId: site.id };
}

async function completedCrawl(siteId: string, projectId: string): Promise<string> {
  const crawl = await prisma.crawl.create({
    data: { siteId, projectId, status: "COMPLETED", trigger: "SCHEDULED", finishedAt: new Date() },
  });
  return crawl.id;
}

async function addScore(projectId: string, crawlId: string, composite: number): Promise<void> {
  await scores.insert({
    projectId,
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

beforeAll(() => {
  prisma = createTestPrisma();
  scores = new ScoresRepo(prisma);
  events = new EventsRepo(prisma);
  recommendations = new RecommendationsRepo(prisma);
});

beforeEach(async () => {
  await truncateAll(prisma);
  mailer = new FakeMailer();
  deps = {
    projects: new ProjectsRepo(prisma),
    users: new UsersRepo(prisma),
    scores,
    events,
    recommendations,
    mailer,
    clock: { now: () => now },
    baseUrl: "https://app.vryse.example",
    log,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a quiet week", () => {
  it("sends no email when the score held steady and nothing else moved", async () => {
    const seeded = await seedProject();
    const crawlA = await completedCrawl(seeded.siteId, seeded.projectId);
    await addScore(seeded.projectId, crawlA, 70);
    const crawlB = await completedCrawl(seeded.siteId, seeded.projectId);
    await addScore(seeded.projectId, crawlB, 70);

    const result = await sendDigest(deps, { projectId: seeded.projectId });

    if (!result.ok) throw result.error;
    expect(result.value.sent).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("a week with real movement", () => {
  it("emails the correct score delta, citation counts, and recommendation churn", async () => {
    const seeded = await seedProject();
    const crawlA = await completedCrawl(seeded.siteId, seeded.projectId);
    await addScore(seeded.projectId, crawlA, 60);
    const crawlB = await completedCrawl(seeded.siteId, seeded.projectId);
    await addScore(seeded.projectId, crawlB, 72);

    await events.record({ projectId: seeded.projectId, kind: "citation_gained", payload: {} });
    await events.record({ projectId: seeded.projectId, kind: "citation_gained", payload: {} });
    await events.record({ projectId: seeded.projectId, kind: "citation_lost", payload: {} });

    const rec = await recommendations.upsertByFingerprint({
      projectId: seeded.projectId,
      fingerprint: "rec-resolved",
      source: "RULE",
      ruleKey: "thin-content",
      title: "Add comparison content",
      body: "…",
      priority: "HIGH",
      impact: 4,
      difficulty: 2,
      evidence: {},
      crawlId: crawlB,
    });
    await recommendations.setClientStatus(rec.id, "DONE");

    await recommendations.upsertByFingerprint({
      projectId: seeded.projectId,
      fingerprint: "rec-opened",
      source: "RULE",
      ruleKey: "missing-meta",
      title: "Add meta descriptions",
      body: "…",
      priority: "LOW",
      impact: 1,
      difficulty: 1,
      evidence: {},
      crawlId: crawlB,
    });

    const result = await sendDigest(deps, { projectId: seeded.projectId });

    if (!result.ok) throw result.error;
    expect(result.value.sent).toBe(true);
    expect(mailer.sent).toHaveLength(1);

    const email = mailer.sent[0];
    expect(email?.subject).toContain("Acme");
    expect(email?.html).toContain("12"); // 72 - 60
    expect(email?.html).toContain("72");
    expect(email?.html).toContain("2 new citation win");
    expect(email?.html).toContain("1 citation loss");
    expect(email?.html).toContain("1 recommendation(s) resolved");
    // Both the resolved card and the still-open one were created this week, so both count
    // toward "opened" — churn counts creation and resolution independently.
    expect(email?.html).toContain("2 new recommendation(s) opened");
  });

  it("still emails on citation movement alone, with an unchanged score", async () => {
    const seeded = await seedProject();
    const crawlA = await completedCrawl(seeded.siteId, seeded.projectId);
    await addScore(seeded.projectId, crawlA, 70);
    const crawlB = await completedCrawl(seeded.siteId, seeded.projectId);
    await addScore(seeded.projectId, crawlB, 70);
    await events.record({ projectId: seeded.projectId, kind: "citation_lost", payload: {} });

    const result = await sendDigest(deps, { projectId: seeded.projectId });

    if (!result.ok) throw result.error;
    expect(result.value.sent).toBe(true);
    expect(mailer.sent[0]?.html).toContain("held steady");
  });
});

describe("access", () => {
  it("resolves to nothing rather than throwing for a deleted project", async () => {
    const result = await sendDigest(deps, { projectId: "00000000-0000-0000-0000-000000000000" });
    expect(result.ok).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });
});
