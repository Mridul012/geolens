/**
 * `GET /v1/projects/{id}/comparison` (M16 acceptance, docs/API.md §3 — Competitors).
 *
 * A contract-shape test: the route resolves auth, calls the one use case, and maps the
 * result — nothing more. The use case's own behaviour across data states is covered by
 * `tests/integration/analysis/read-comparison.test.ts`; this file exists to pin the wire
 * shape and the access-control boundary.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, cookieHeaderFrom, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let harness: TestApp;

/**
 * Comparison is a PRO unlock (M19), so every fixture in this file signs up PRO by
 * default — the one exception is the dedicated plan-gate test, which passes `plan: "FREE"`.
 */
async function signUp(email = "priya@acme.test", plan: "FREE" | "PRO" = "PRO"): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Priya" },
  });
  expect(response.statusCode).toBe(200);

  if (plan === "PRO") {
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email } });
    await harness.prisma.subscription.create({
      data: { userId: user.id, stripeCustomerId: `cus_${randomUUID()}`, plan: "PRO", status: "ACTIVE" },
    });
  }

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

async function getComparison(cookie: string, projectId: string) {
  return harness.app.inject({
    method: "GET",
    url: `/v1/projects/${projectId}/comparison`,
    headers: { cookie },
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

describe("shape", () => {
  it("returns the own column, a null competitor, and no share of voice for a fresh project", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await getComparison(cookie, projectId);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.competitor).toBeNull();
    expect(body.shareOfVoice).toBeNull();
    expect(body.missingTopics).toEqual([]);
    expect(body.own).toMatchObject({
      domain: "acme.com",
      crawlId: null,
      metrics: {
        aiVisibility: null,
        topicCoverage: null,
        authority: null,
        contentFreshness: null,
        pageCount: null,
        blogCoverage: null,
        trustSignals: null,
      },
    });
  });

  it("surfaces a tracked competitor's identity even before it has a crawl", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await harness.prisma.site.create({
      data: { projectId, url: "https://rival.com", domain: "rival.com", role: "COMPETITOR" },
    });

    const body = (await getComparison(cookie, projectId)).json();

    expect(body.competitor).toMatchObject({ domain: "rival.com", crawlId: null });
  });
});

describe("access", () => {
  it("requires a session", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/comparison`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s another user's project rather than confirming it exists", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const stranger = await signUp("stranger@rival.test");

    expect((await getComparison(stranger, projectId)).statusCode).toBe(404);
  });

  it("404s a project id that does not exist at all", async () => {
    const cookie = await signUp();

    const response = await getComparison(cookie, "00000000-0000-0000-0000-000000000000");

    expect(response.statusCode).toBe(404);
  });

  it("403s PLAN_LIMIT_EXCEEDED for a FREE-plan account (M19)", async () => {
    const cookie = await signUp("free@acme.test", "FREE");
    const projectId = await createProject(cookie);

    const response = await getComparison(cookie, projectId);

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PLAN_LIMIT_EXCEEDED");
  });
});
