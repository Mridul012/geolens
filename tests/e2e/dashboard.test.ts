/**
 * The dashboard and score endpoints over HTTP (M12 acceptance, docs/API.md §3).
 *
 * The drawer is the product's answer to "why is my score this?", so what matters here is
 * that every component resolves to a weight, a reason and its evidence — and that a
 * project with no score yet gets 200 and a null, never a 404.
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

const BREAKDOWN = {
  configVersion: "scoring.v1",
  totalWeight: 0.65,
  published: true,
  degraded: false,
  components: [
    { component: "citation", value: null, weight: 0.35, effectiveWeight: 0, reason: "unavailable_yet", evidence: null },
    { component: "retrievability", value: 60, weight: 0.2, effectiveWeight: 0.3077, reason: null, evidence: { questionsTotal: 30 } },
    { component: "contentQuality", value: 70, weight: 0.15, effectiveWeight: 0.2308, reason: null, evidence: { pagesScored: 12 } },
    { component: "topicCoverage", value: 40, weight: 0.15, effectiveWeight: 0.2308, reason: null, evidence: { topicsScored: 14 } },
    { component: "technical", value: 90, weight: 0.1, effectiveWeight: 0.1538, reason: null, evidence: { parts: {} } },
    { component: "trust", value: 50, weight: 0.05, effectiveWeight: 0.0769, reason: null, evidence: { parts: {} } },
  ],
};

async function addScore(projectId: string, composite: number, createdAt?: Date): Promise<string> {
  const site = await harness.prisma.site.findFirstOrThrow({ where: { projectId } });
  const crawl = await harness.prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId,
      status: "COMPLETED",
      trigger: "MANUAL",
      finishedAt: new Date(),
    },
  });
  const score = await harness.prisma.score.create({
    data: {
      projectId,
      crawlId: crawl.id,
      composite,
      scoreCitation: null,
      scoreRetrievability: 60,
      scoreContentQuality: 70,
      scoreTopicCoverage: 40,
      scoreTechnical: 90,
      scoreTrust: 50,
      components: BREAKDOWN,
      scoringConfigVersion: "scoring.v1",
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  });
  return score.id;
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

describe("GET /dashboard", () => {
  it("serves the empty state for a project with no crawl", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/dashboard`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasCompletedCrawl: false,
      latestScore: null,
      indexedPages: 0,
      scoreTrend: [],
    });
  });

  it("serves the latest score and the trend once crawls have run", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addScore(projectId, 55, new Date(Date.now() - 86_400_000));
    await addScore(projectId, 72);

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/dashboard`,
        headers: { cookie },
      })
    ).json();

    expect(body.hasCompletedCrawl).toBe(true);
    expect(body.latestScore.composite).toBe(72);
    expect(body.scoreTrend.map((point: { composite: number }) => point.composite)).toEqual([
      55, 72,
    ]);
  });

  it("requires a session", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/dashboard`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s another user's project", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/dashboard`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /scores/latest — the breakdown drawer", () => {
  it("returns 200 with a null score before the first one, not a 404", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/scores/latest`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ score: null, components: null });
  });

  it("resolves every component to a weight, a reason and its evidence", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addScore(projectId, 62);

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/scores/latest`,
        headers: { cookie },
      })
    ).json();

    expect(body.score.composite).toBe(62);
    expect(body.score.scoringConfigVersion).toBe("scoring.v1");

    const rows = body.components.components as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(typeof row["weight"]).toBe("number");
      if (row["value"] === null) {
        expect(row["reason"]).toBe("unavailable_yet");
      } else {
        expect(row["reason"]).toBeNull();
        expect(row["evidence"]).not.toBeNull();
      }
    }
  });

  it("404s another user's project", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    await addScore(projectId, 62);
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/scores/latest`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /scores — history", () => {
  it("returns points oldest to newest", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addScore(projectId, 40, new Date("2026-01-01T00:00:00Z"));
    await addScore(projectId, 55, new Date("2026-02-01T00:00:00Z"));
    await addScore(projectId, 70, new Date("2026-03-01T00:00:00Z"));

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/scores`,
        headers: { cookie },
      })
    ).json();

    expect(body.data.map((score: { composite: number }) => score.composite)).toEqual([40, 55, 70]);
    expect(body.nextCursor).toBeNull();
  });

  it("filters to a window", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addScore(projectId, 40, new Date("2026-01-01T00:00:00Z"));
    await addScore(projectId, 70, new Date("2026-03-01T00:00:00Z"));

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/scores?from=2026-02-01T00:00:00.000Z`,
        headers: { cookie },
      })
    ).json();

    expect(body.data.map((score: { composite: number }) => score.composite)).toEqual([70]);
  });

  it("pages with a cursor rather than an offset", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    for (let index = 0; index < 5; index += 1) {
      await addScore(projectId, 40 + index, new Date(Date.UTC(2026, 0, index + 1)));
    }

    const first = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/scores?limit=2`,
        headers: { cookie },
      })
    ).json();
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/scores?limit=2&cursor=${first.nextCursor}`,
        headers: { cookie },
      })
    ).json();
    expect(second.data).toHaveLength(2);
    expect(second.data[0].id).not.toBe(first.data[0].id);
  });

  it("rejects a limit outside the documented range", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/scores?limit=500`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s another user's history", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/scores`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});
