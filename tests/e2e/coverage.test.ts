/**
 * `GET /v1/projects/{id}/topics/coverage` (M10 acceptance, docs/API.md §3).
 *
 * The endpoint's job is to resolve "latest own crawl vs latest competitor crawl" on the
 * server so no client ever has to (docs/API.md §5.6), and to be honest about the empty
 * states a real account passes through on its first day.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, cookieHeaderFrom, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let harness: TestApp;

async function signUp(email = "priya@acme.test"): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Priya" },
  });
  expect(response.statusCode).toBe(200);
  return cookieHeaderFrom(response);
}

async function createProject(cookie: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { cookie },
    payload: { name: "Acme", url: "https://acme.com" },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

async function getCoverage(cookie: string, projectId: string) {
  return harness.app.inject({
    method: "GET",
    url: `/v1/projects/${projectId}/topics/coverage`,
    headers: { cookie },
  });
}

/** A completed crawl for a site, with coverage already computed for the given topics. */
async function completedCrawlWithCoverage(
  siteId: string,
  projectId: string,
  scores: ReadonlyArray<{ topicId: string; coverageScore: number; depthChunks: number }>,
): Promise<string> {
  const crawl = await harness.prisma.crawl.create({
    data: {
      siteId,
      projectId,
      status: "COMPLETED",
      trigger: "MANUAL",
      finishedAt: new Date(),
    },
  });
  await harness.prisma.topicCoverage.createMany({
    data: scores.map((score) => ({ crawlId: crawl.id, ...score })),
  });
  return crawl.id;
}

async function addTopic(cookie: string, projectId: string, label: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/topics`,
    headers: { cookie },
    payload: { label },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

beforeAll(async () => {
  harness = await buildTestApp();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.prisma);
});

describe("empty states", () => {
  it("returns a row per topic with nulls before any crawl has finished", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addTopic(cookie, projectId, "Pricing");
    await addTopic(cookie, projectId, "Security");

    const response = await getCoverage(cookie, projectId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ownCrawlId: null, competitorCrawlId: null });
    expect(response.json().data).toHaveLength(2);
    // Null is "we have not measured this", which is not the same claim as zero.
    for (const row of response.json().data) {
      expect(row).toMatchObject({
        ownCoverage: null,
        ownDepth: null,
        competitorCoverage: null,
        gap: null,
        missing: false,
      });
    }
  });

  it("returns an empty list for a project with no taxonomy yet", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await getCoverage(cookie, projectId);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });
});

describe("own coverage", () => {
  it("serves the latest completed crawl's scores", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const pricing = await addTopic(cookie, projectId, "Pricing");
    const site = await harness.prisma.site.findFirstOrThrow({ where: { projectId } });

    await completedCrawlWithCoverage(site.id, projectId, [
      { topicId: pricing, coverageScore: 20, depthChunks: 1 },
    ]);
    const latest = await completedCrawlWithCoverage(site.id, projectId, [
      { topicId: pricing, coverageScore: 80, depthChunks: 9 },
    ]);

    const response = await getCoverage(cookie, projectId);

    expect(response.json().ownCrawlId).toBe(latest);
    expect(response.json().data[0]).toMatchObject({ ownCoverage: 80, ownDepth: 9 });
  });

  it("ignores a crawl that has not completed", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const pricing = await addTopic(cookie, projectId, "Pricing");
    const site = await harness.prisma.site.findFirstOrThrow({ where: { projectId } });

    const completed = await completedCrawlWithCoverage(site.id, projectId, [
      { topicId: pricing, coverageScore: 80, depthChunks: 9 },
    ]);
    await harness.prisma.crawl.create({
      data: { siteId: site.id, projectId, status: "CRAWLING", trigger: "MANUAL" },
    });

    expect((await getCoverage(cookie, projectId)).json().ownCrawlId).toBe(completed);
  });

  it("omits archived topics", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const pricing = await addTopic(cookie, projectId, "Pricing");
    const retired = await addTopic(cookie, projectId, "Retired");

    await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${retired}`,
      headers: { cookie },
      payload: { status: "ARCHIVED" },
    });

    const rows = (await getCoverage(cookie, projectId)).json().data;
    expect(rows.map((row: { topicId: string }) => row.topicId)).toEqual([pricing]);
  });
});

describe("competitor comparison", () => {
  async function bothSides(cookie: string, projectId: string) {
    const pricing = await addTopic(cookie, projectId, "Pricing");
    const migration = await addTopic(cookie, projectId, "Migration");
    const ownSite = await harness.prisma.site.findFirstOrThrow({
      where: { projectId, role: "OWN" },
    });
    const rivalSite = await harness.prisma.site.create({
      data: { projectId, url: "https://rival.com", domain: "rival.com", role: "COMPETITOR" },
    });

    const ownCrawl = await completedCrawlWithCoverage(ownSite.id, projectId, [
      { topicId: pricing, coverageScore: 78, depthChunks: 8 },
      { topicId: migration, coverageScore: 4, depthChunks: 0 },
    ]);
    const rivalCrawl = await completedCrawlWithCoverage(rivalSite.id, projectId, [
      { topicId: pricing, coverageScore: 71, depthChunks: 7 },
      { topicId: migration, coverageScore: 84, depthChunks: 9 },
    ]);

    return { pricing, migration, ownCrawl, rivalCrawl };
  }

  it("ranks the gap first and flags only what is genuinely missing", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const { pricing, migration, ownCrawl, rivalCrawl } = await bothSides(cookie, projectId);

    const body = (await getCoverage(cookie, projectId)).json();

    expect(body.ownCrawlId).toBe(ownCrawl);
    expect(body.competitorCrawlId).toBe(rivalCrawl);
    expect(body.data[0]).toMatchObject({
      topicId: migration,
      ownCoverage: 4,
      competitorCoverage: 84,
      gap: 80,
      missing: true,
    });
    // We are ahead on pricing; being behind by seven points is not a gap worth surfacing.
    expect(body.data[1]).toMatchObject({ topicId: pricing, gap: -7, missing: false });
  });
});

describe("access", () => {
  it("requires a session", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/topics/coverage`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s another user's project rather than confirming it exists", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const stranger = await signUp("stranger@rival.test");

    expect((await getCoverage(stranger, projectId)).statusCode).toBe(404);
  });

  it("does not shadow the topic detail route", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const topicId = await addTopic(cookie, projectId, "Pricing");

    // `/topics/coverage` is a static segment and must win over `/topics/:topicId`, while
    // the parameterised route keeps working for a real id.
    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${topicId}`,
      headers: { cookie },
      payload: { label: "Pricing and plans" },
    });
    expect(patched.statusCode).toBe(200);
    expect((await getCoverage(cookie, projectId)).statusCode).toBe(200);
  });
});
