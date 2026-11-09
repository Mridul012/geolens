/**
 * Report endpoints over HTTP (M17 acceptance, docs/API.md §3 — Reports).
 *
 * Job execution itself is covered elsewhere (`tests/integration/reports/`); this file
 * pins the wire contract — the 202/Location/Idempotency-Key shape shared with crawls and
 * prompt-runs, the documented empty state (no completed crawl), the status poll, and the
 * download redirect's NOT_READY vs READY behaviour.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, cookieHeaderFrom, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let harness: TestApp;

/**
 * Reports are a PRO unlock (M19), so every fixture in this file signs up PRO by default —
 * the one exception is the dedicated plan-gate test, which passes `plan: "FREE"`.
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
      data: {
        userId: user.id,
        // A full random suffix, not a slice of the UUIDv7 user id: two users created
        // milliseconds apart share that id's leading (timestamp) bytes, which would
        // collide on the table's unique stripe_customer_id constraint.
        stripeCustomerId: `cus_${randomUUID()}`,
        plan: "PRO",
        status: "ACTIVE",
      },
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

async function completeCrawl(projectId: string): Promise<string> {
  const site = await harness.prisma.site.findFirstOrThrow({ where: { projectId, role: "OWN" } });
  const crawl = await harness.prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId,
      status: "COMPLETED",
      trigger: "MANUAL",
      finishedAt: new Date(),
    },
  });
  return crawl.id;
}

async function generate(
  cookie: string,
  projectId: string,
  key = "report-key-1",
  body: Record<string, unknown> = {},
) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/reports`,
    headers: { cookie, "idempotency-key": key },
    payload: body,
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

describe("POST /reports", () => {
  it("queues a report with 202, a Location header, and enqueues the job", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const crawlId = await completeCrawl(projectId);

    const response = await generate(cookie, projectId);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ kind: "ON_DEMAND", status: "QUEUED", crawlId });
    expect(response.headers["location"]).toContain(`/reports/${response.json().id}`);
    expect(harness.enqueued().some((job) => job.queue === "report")).toBe(true);
  });

  it("accepts an explicit sections list", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);

    const response = await generate(cookie, projectId, "report-key-sections", {
      sections: ["summary", "score"],
    });

    expect(response.statusCode).toBe(202);
  });

  it("rejects an unknown section rather than silently ignoring it", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);

    const response = await generate(cookie, projectId, "report-key-bad-section", {
      sections: ["not-a-real-section"],
    });

    expect(response.statusCode).toBe(400);
  });

  it("requires an Idempotency-Key", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].path).toBe("Idempotency-Key");
  });

  it("replays the same response for a repeated key rather than creating a second report", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);

    const first = await generate(cookie, projectId, "report-key-replay");
    const second = await generate(cookie, projectId, "report-key-replay");

    expect(second.statusCode).toBe(202);
    expect(second.json().id).toBe(first.json().id);
    const rows = await harness.prisma.report.findMany({ where: { projectId } });
    expect(rows).toHaveLength(1);
  });

  it("403s PLAN_LIMIT_EXCEEDED for a FREE-plan account (M19)", async () => {
    const cookie = await signUp("free@acme.test", "FREE");
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);

    const response = await generate(cookie, projectId, "report-key-free-plan");

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("409s NO_COMPLETED_CRAWL when the site has never finished a crawl", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await generate(cookie, projectId);

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("NO_COMPLETED_CRAWL");
  });

  it("404s another user's project rather than confirming it exists", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    await completeCrawl(projectId);
    const stranger = await signUp("stranger@rival.test");

    expect((await generate(stranger, projectId, "report-key-stranger")).statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/reports`,
      headers: { "idempotency-key": "report-key-noauth" },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("GET /reports and status polling", () => {
  it("lists reports newest first and serves individual status", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);
    const created = (await generate(cookie, projectId, "report-key-list")).json();

    const list = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/reports`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((r: { id: string }) => r.id)).toContain(created.id);

    const detail = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/reports/${created.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: created.id, status: "QUEUED" });
  });

  it("404s a report id from another project", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);
    const created = (await generate(cookie, projectId, "report-key-detail")).json();

    const otherCookie = await signUp("other@acme.test");
    const otherProjectId = await createProject(otherCookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${otherProjectId}/reports/${created.id}`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /reports/{id}/download", () => {
  it("409s REPORT_NOT_READY before generation finishes", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);
    const created = (await generate(cookie, projectId, "report-key-download-pending")).json();

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/reports/${created.id}/download`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("REPORT_NOT_READY");
  });

  it("302s to a signed URL once the report is READY", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);
    const created = (await generate(cookie, projectId, "report-key-download-ready")).json();

    await harness.prisma.report.update({
      where: { id: created.id },
      data: {
        status: "READY",
        storageKey: `reports/${projectId}/${created.id}.pdf`,
        sizeBytes: 12_345,
        generatedAt: new Date(),
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/reports/${created.id}/download`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers["location"]).toBeTruthy();
  });

  it("404s a report that does not exist", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completeCrawl(projectId);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/reports/00000000-0000-0000-0000-000000000000/download`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});
