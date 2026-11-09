/**
 * The crawl-complete email (M18): sent to the project's owner, naming the right domain and
 * score — or honestly saying "pending" when there is none yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import {
  notifyCrawlComplete,
  type NotifyCrawlCompleteDeps,
} from "../../../src/application/notifications/notify-crawl-complete.js";
import { FakeMailer } from "../../../src/infrastructure/email/fake-mailer.js";
import { ProjectsRepo } from "../../../src/infrastructure/db/repositories/projects.repo.js";
import { ScoresRepo } from "../../../src/infrastructure/db/repositories/scores.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let mailer: FakeMailer;
let scores: ScoresRepo;
let deps: NotifyCrawlCompleteDeps;

const log = pino({ level: "silent" });

beforeAll(() => {
  prisma = createTestPrisma();
  scores = new ScoresRepo(prisma);
});

beforeEach(async () => {
  await truncateAll(prisma);
  mailer = new FakeMailer();
  deps = {
    projects: new ProjectsRepo(prisma),
    users: new UsersRepo(prisma),
    scores,
    mailer,
    baseUrl: "https://app.vryse.example",
    log,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("notifyCrawlComplete", () => {
  it("emails the owner with the domain and composite score", async () => {
    const user = await prisma.user.create({ data: { email: "owner@acme.test" } });
    const project = await prisma.project.create({ data: { userId: user.id, name: "Acme" } });
    const site = await prisma.site.create({
      data: { projectId: project.id, url: "https://acme.com", domain: "acme.com", role: "OWN" },
    });
    const crawl = await prisma.crawl.create({
      data: { siteId: site.id, projectId: project.id, status: "COMPLETED", trigger: "MANUAL" },
    });
    await scores.insert({
      projectId: project.id,
      crawlId: crawl.id,
      promptRunId: null,
      composite: 68,
      citation: null,
      retrievability: 60,
      contentQuality: 70,
      topicCoverage: 50,
      technical: 90,
      trust: 40,
      components: { configVersion: "scoring.v1", components: [] },
      scoringConfigVersion: "scoring.v1",
    });

    const result = await notifyCrawlComplete(deps, { projectId: project.id, crawlId: crawl.id });

    if (!result.ok) throw result.error;
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("owner@acme.test");
    expect(mailer.sent[0]?.html).toContain("acme.com");
    expect(mailer.sent[0]?.html).toContain("68");
  });

  it("says the score is pending when the crawl published none", async () => {
    const user = await prisma.user.create({ data: { email: "owner2@acme.test" } });
    const project = await prisma.project.create({ data: { userId: user.id, name: "Fresh" } });
    const site = await prisma.site.create({
      data: { projectId: project.id, url: "https://fresh.co", domain: "fresh.co", role: "OWN" },
    });
    const crawl = await prisma.crawl.create({
      data: { siteId: site.id, projectId: project.id, status: "COMPLETED", trigger: "MANUAL" },
    });

    const result = await notifyCrawlComplete(deps, { projectId: project.id, crawlId: crawl.id });

    if (!result.ok) throw result.error;
    expect(mailer.sent[0]?.html).toContain("pending");
  });

  it("resolves to nothing for a deleted project rather than throwing", async () => {
    const result = await notifyCrawlComplete(deps, {
      projectId: "00000000-0000-0000-0000-000000000000",
      crawlId: "00000000-0000-0000-0000-000000000000",
    });

    expect(result.ok).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });
});
