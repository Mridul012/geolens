/**
 * The crawler's HTTP surface (M6 acceptance): 202 + Location + required Idempotency-Key,
 * the active-crawl 409, replay semantics, the SSE envelope, and the history feed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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

async function createProject(cookie: string): Promise<{ id: string; siteId: string }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { cookie },
    payload: { name: "Acme", url: "https://acme.com" },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { id: body.id, siteId: body.sites[0].id };
}

async function startCrawl(
  cookie: string,
  projectId: string,
  options: { key?: string; payload?: Record<string, unknown> } = {},
) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/crawls`,
    headers: {
      cookie,
      ...(options.key === undefined ? {} : { "idempotency-key": options.key }),
    },
    payload: options.payload ?? {},
  });
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

describe("POST /crawls", () => {
  it("returns 202 with a Location header and enqueues exactly one job", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    const response = await startCrawl(cookie, project.id, { key: randomUUID() });

    expect(response.statusCode).toBe(202);
    const crawl = response.json();
    expect(crawl.status).toBe("QUEUED");
    expect(crawl.trigger).toBe("MANUAL");
    expect(crawl.siteId).toBe(project.siteId);
    expect(crawl.stats).toEqual({
      pagesDiscovered: 0,
      pagesCrawled: 0,
      pagesChanged: 0,
      pagesFailed: 0,
    });
    expect(response.headers["location"]).toBe(
      `http://localhost:3000/v1/projects/${project.id}/crawls/${crawl.id}`,
    );

    const jobs = harness.enqueued();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.queue).toBe("crawl");
    expect(jobs[0]?.jobId).toBe(`crawl-${crawl.id}`);
    expect(jobs[0]?.payload).toMatchObject({ crawlId: crawl.id, projectId: project.id });
  });

  it("requires an Idempotency-Key", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    const response = await startCrawl(cookie, project.id);

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
    expect(response.json().errors[0].path).toBe("Idempotency-Key");
    expect(await harness.prisma.crawl.count()).toBe(0);
  });

  it("replays the original 202 for the same key and payload", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const key = randomUUID();

    const first = await startCrawl(cookie, project.id, { key });
    const replay = await startCrawl(cookie, project.id, { key });

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().id).toBe(first.json().id);
    // The double-click created one crawl, not two.
    expect(await harness.prisma.crawl.count()).toBe(1);
  });

  it("rejects the same key with a different payload", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    const competitor = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
      payload: { url: "https://rival.com" },
    });
    const competitorSiteId = competitor.json().id;

    const key = randomUUID();
    await startCrawl(cookie, project.id, { key });
    const reused = await startCrawl(cookie, project.id, {
      key,
      payload: { siteId: competitorSiteId },
    });

    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuses a second crawl while one is active", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    const first = await startCrawl(cookie, project.id, { key: randomUUID() });
    expect(first.statusCode).toBe(202);

    const second = await startCrawl(cookie, project.id, { key: randomUUID() });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("CRAWL_ALREADY_ACTIVE");
    expect(await harness.prisma.crawl.count()).toBe(1);
  });

  it("allows a new crawl once the previous one is terminal", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    const first = await startCrawl(cookie, project.id, { key: randomUUID() });
    await harness.prisma.crawl.update({
      where: { id: first.json().id },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const second = await startCrawl(cookie, project.id, { key: randomUUID() });
    expect(second.statusCode).toBe(202);
  });

  it("can target the competitor site explicitly", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const competitor = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
      payload: { url: "https://rival.com" },
    });

    const response = await startCrawl(cookie, project.id, {
      key: randomUUID(),
      payload: { siteId: competitor.json().id },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().siteId).toBe(competitor.json().id);
  });

  it("404s for another user's project", async () => {
    const owner = await signUp("owner@acme.test");
    const project = await createProject(owner);
    const stranger = await signUp("stranger@rival.test");

    const response = await startCrawl(stranger, project.id, { key: randomUUID() });
    expect(response.statusCode).toBe(404);
    expect(await harness.prisma.crawl.count()).toBe(0);
  });
});

describe("the on-demand crawl quota (M19)", () => {
  it("refuses a FREE account's 4th crawl in a week, and says why", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    // FREE allows 3 on-demand crawls per rolling week (config/plans.ts). Each must reach a
    // terminal state before the next, or the active-crawl 409 would mask the quota check.
    for (let index = 0; index < 3; index += 1) {
      const response = await startCrawl(cookie, project.id, { key: randomUUID() });
      expect(response.statusCode).toBe(202);
      await harness.prisma.crawl.update({
        where: { id: response.json().id },
        data: { status: "COMPLETED", finishedAt: new Date() },
      });
    }

    const fourth = await startCrawl(cookie, project.id, { key: randomUUID() });

    expect(fourth.statusCode).toBe(403);
    expect(fourth.json().code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("allows a PRO account well past the FREE ceiling", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email: "priya@acme.test" } });
    await harness.prisma.subscription.create({
      data: { userId: user.id, stripeCustomerId: "cus_crawl_quota", plan: "PRO", status: "ACTIVE" },
    });
    const project = await createProject(cookie);

    for (let index = 0; index < 4; index += 1) {
      const response = await startCrawl(cookie, project.id, { key: randomUUID() });
      expect(response.statusCode).toBe(202);
      await harness.prisma.crawl.update({
        where: { id: response.json().id },
        data: { status: "COMPLETED", finishedAt: new Date() },
      });
    }
  });

  it("never counts a SCHEDULED crawl against the on-demand quota", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    // A SCHEDULED crawl a customer never triggered themselves must not eat into the
    // on-demand allowance they see in the UI.
    await harness.prisma.crawl.create({
      data: {
        siteId: project.siteId,
        projectId: project.id,
        status: "COMPLETED",
        trigger: "SCHEDULED",
        finishedAt: new Date(),
      },
    });

    const response = await startCrawl(cookie, project.id, { key: randomUUID() });

    expect(response.statusCode).toBe(202);
  });
});

describe("crawl reads", () => {
  it("lists crawls newest first with a cursor", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    const first = await startCrawl(cookie, project.id, { key: randomUUID() });
    await harness.prisma.crawl.update({
      where: { id: first.json().id },
      data: { status: "COMPLETED" },
    });
    const second = await startCrawl(cookie, project.id, { key: randomUUID() });

    const list = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls?limit=1`,
      headers: { cookie },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].id).toBe(second.json().id);
    expect(list.json().nextCursor).not.toBeNull();
  });

  it("returns crawl detail and 404s a crawl from another project", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });

    const detail = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(crawl.json().id);

    const stranger = await signUp("stranger@rival.test");
    const denied = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}`,
      headers: { cookie: stranger },
    });
    expect(denied.statusCode).toBe(404);
  });

  it("lists page snapshots, filtered by changed", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    const crawlId = crawl.json().id;

    const page = await harness.prisma.page.create({
      data: {
        siteId: project.siteId,
        url: "https://acme.com/pricing",
        urlHash: "hash-1",
        latestContentHash: "content-1",
      },
    });
    await harness.prisma.pageSnapshot.create({
      data: {
        crawlId,
        pageId: page.id,
        contentHash: "content-1",
        changed: true,
        title: "Pricing",
        wordCount: 420,
        extracted: {},
        storageKey: "snapshots/x/y/z.html.gz",
        fetchedAt: new Date(),
      },
    });

    const all = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawlId}/pages`,
      headers: { cookie },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().data).toHaveLength(1);
    expect(all.json().data[0]).toMatchObject({
      url: "https://acme.com/pricing",
      title: "Pricing",
      changed: true,
      wordCount: 420,
      qualityScore: null,
    });

    const unchangedOnly = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawlId}/pages?changed=false`,
      headers: { cookie },
    });
    expect(unchangedOnly.json().data).toHaveLength(0);
  });
});

describe("GET /crawls/{id}/analysis", () => {
  it("serves the access check with per-bot findings and fixes", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });

    await harness.prisma.crawl.update({
      where: { id: crawl.json().id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        analysis: {
          accessCheck: {
            bots: [
              {
                bot: "GPTBot",
                operator: "OpenAI",
                allowed: false,
                blockedBy: "robots",
                evidence: "robots.txt — User-agent: gptbot / Disallow: /",
                impact: "ChatGPT cannot read your pages.",
                fix: "User-agent: GPTBot\nAllow: /",
              },
            ],
            llmsTxt: { present: false, valid: null, issues: [] },
            robotsTxtPresent: true,
            allowedShare: 67,
            checkedAt: "2026-08-31T00:00:00.000Z",
          },
        },
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/analysis`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.crawlId).toBe(crawl.json().id);
    expect(body.accessCheck.allowedShare).toBe(67);
    expect(body.accessCheck.bots[0]).toMatchObject({
      bot: "GPTBot",
      allowed: false,
      blockedBy: "robots",
    });
    expect(body.accessCheck.bots[0].fix).toContain("Allow: /");
  });

  it("returns honest nulls for the blocks later milestones produce", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    await harness.prisma.crawl.update({
      where: { id: crawl.json().id },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/analysis`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      executiveSummary: null,
      strengths: [],
      weaknesses: [],
      accessCheck: null,
      retrievability: null,
      structuredDataHealth: null,
      technicalIssues: [],
    });
  });

  it("409s while the crawl has not run yet", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/analysis`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });

  it("drops a stored block that no longer matches the contract", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    await harness.prisma.crawl.update({
      where: { id: crawl.json().id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        // Written by an older pipeline: shape no longer valid.
        analysis: { accessCheck: { bots: "not an array" } },
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/analysis`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    // A malformed finding is worse than a missing one.
    expect(response.json().accessCheck).toBeNull();
  });

  it("404s another user's crawl analysis", async () => {
    const cookie = await signUp("owner@acme.test");
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    await harness.prisma.crawl.update({
      where: { id: crawl.json().id },
      data: { status: "COMPLETED" },
    });
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/analysis`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /snapshots/{id} — the evidence view", () => {
  it("returns the extraction artifacts behind a snapshot", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });

    const page = await harness.prisma.page.create({
      data: {
        siteId: project.siteId,
        url: "https://acme.com/pricing",
        urlHash: "hash-1",
        latestContentHash: "content-1",
      },
    });
    const snapshot = await harness.prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.json().id,
        pageId: page.id,
        contentHash: "content-1",
        changed: true,
        title: "Pricing",
        wordCount: 420,
        httpStatus: 200,
        hasStructuredData: true,
        internalLinkCount: 9,
        externalLinkCount: 2,
        extracted: {
          title: "Pricing",
          headings: [{ level: 1, text: "Pricing", path: "Pricing" }],
          structuredDataTypes: ["Product"],
        },
        storageKey: "snapshots/x/y/z.html.gz",
        fetchedAt: new Date(),
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/snapshots/${snapshot.id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: snapshot.id,
      url: "https://acme.com/pricing",
      title: "Pricing",
      changed: true,
      wordCount: 420,
      hasStructuredData: true,
      internalLinkCount: 9,
      externalLinkCount: 2,
      quality: null,
      carriedForwardFromId: null,
    });
    // The artifacts a recommendation links to must actually resolve.
    expect(response.json().extracted.structuredDataTypes).toEqual(["Product"]);
    expect(response.json().extracted.headings[0].path).toBe("Pricing");
  });

  it("404s a snapshot belonging to another user's project", async () => {
    const cookie = await signUp("owner@acme.test");
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    const page = await harness.prisma.page.create({
      data: { siteId: project.siteId, url: "https://acme.com/x", urlHash: "h", latestContentHash: "c" },
    });
    const snapshot = await harness.prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.json().id,
        pageId: page.id,
        contentHash: "c",
        extracted: {},
        storageKey: "k",
        fetchedAt: new Date(),
      },
    });

    const stranger = await signUp("stranger@rival.test");
    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/snapshots/${snapshot.id}`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s an unknown snapshot id", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/snapshots/00000000-0000-4000-8000-000000000000`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
  });
});

describe("cancel", () => {
  it("cancels a queued crawl immediately", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/cancel`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("CANCELED");
  });

  it("flags a running crawl for the worker to notice", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    await harness.prisma.crawl.update({
      where: { id: crawl.json().id },
      data: { status: "CRAWLING" },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/cancel`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    // Still CRAWLING: the worker owns the transition, at its next safe point.
    expect(response.json().status).toBe("CRAWLING");
  });

  it("409s a crawl that already finished", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    await harness.prisma.crawl.update({
      where: { id: crawl.json().id },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/cancel`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe("SSE progress", () => {
  it("streams stage, progress and done, then ends", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    const crawlId = crawl.json().id;

    // Terminal state already present, so the stream resolves on its first poll — the
    // reconnect case the contract calls resume-safe.
    await harness.prisma.crawl.update({
      where: { id: crawlId },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawlId}/progress`,
      headers: { cookie },
      payloadAsStream: false,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: stage");
    expect(response.body).toContain("event: progress");
    expect(response.body).toContain("event: done");
  });

  it("404s the stream for another user's crawl", async () => {
    const cookie = await signUp("owner@acme.test");
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/crawls/${crawl.json().id}/progress`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /events", () => {
  it("shows crawl_completed in the feed", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);
    const crawl = await startCrawl(cookie, project.id, { key: randomUUID() });

    await harness.prisma.event.create({
      data: {
        projectId: project.id,
        kind: "crawl_completed",
        crawlId: crawl.json().id,
        payload: { pagesCrawled: 12 },
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/events`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const feed = response.json();
    expect(feed.data).toHaveLength(1);
    expect(feed.data[0]).toMatchObject({
      kind: "crawl_completed",
      crawlId: crawl.json().id,
      payload: { pagesCrawled: 12 },
    });
    // bigint ids are string-encoded at the boundary (Engineering-Rules §3).
    expect(typeof feed.data[0].id).toBe("string");
  });

  it("filters by kind and paginates newest first", async () => {
    const cookie = await signUp();
    const project = await createProject(cookie);

    for (const kind of ["crawl_completed", "score_changed", "crawl_completed"]) {
      await harness.prisma.event.create({
        data: { projectId: project.id, kind, payload: {} },
      });
    }

    const filtered = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/events?kind=crawl_completed`,
      headers: { cookie },
    });
    expect(filtered.json().data).toHaveLength(2);

    const firstPage = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/events?limit=2`,
      headers: { cookie },
    });
    expect(firstPage.json().data).toHaveLength(2);
    expect(firstPage.json().nextCursor).not.toBeNull();

    const secondPage = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/events?limit=2&cursor=${firstPage.json().nextCursor}`,
      headers: { cookie },
    });
    expect(secondPage.json().data).toHaveLength(1);
  });

  it("404s another user's feed", async () => {
    const cookie = await signUp("owner@acme.test");
    const project = await createProject(cookie);
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/events`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});
