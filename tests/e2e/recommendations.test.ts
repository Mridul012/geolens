/**
 * Recommendation endpoints over HTTP (M13 acceptance, docs/API.md §3).
 *
 * The transition matrix is the point. Two of the five statuses belong to the pipeline —
 * "we crawled again and the issue is genuinely gone" is a claim only we can make — so a
 * client that could set them would be marking its own homework, and the confirmation would
 * mean nothing.
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

async function addRecommendation(
  projectId: string,
  overrides: Partial<{
    fingerprint: string;
    ruleKey: string | null;
    source: "RULE" | "AI";
    priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    impact: number;
    difficulty: number;
    status: "OPEN" | "DONE" | "DISMISSED" | "VALIDATED" | "REGRESSED";
    title: string;
  }> = {},
): Promise<string> {
  const row = await harness.prisma.recommendation.create({
    data: {
      projectId,
      fingerprint: overrides.fingerprint ?? `rule:${overrides.ruleKey ?? "thin-content"}`,
      source: overrides.source ?? "RULE",
      ruleKey: overrides.ruleKey ?? "thin-content",
      title: overrides.title ?? "Expand 3 thin pages",
      body: "These pages are too short to answer anything.",
      priority: overrides.priority ?? "MEDIUM",
      impact: overrides.impact ?? 3,
      difficulty: overrides.difficulty ?? 3,
      status: overrides.status ?? "OPEN",
      evidence: { snapshotIds: ["snap-1"], urls: ["https://acme.com/thin"] },
    },
  });
  return row.id;
}

async function patchStatus(cookie: string, projectId: string, recId: string, status: string) {
  return harness.app.inject({
    method: "PATCH",
    url: `/v1/projects/${projectId}/recommendations/${recId}`,
    headers: { cookie },
    payload: { status },
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

describe("GET /recommendations", () => {
  it("returns an empty list before the first crawl", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/recommendations`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [], nextCursor: null });
  });

  it("ranks critical findings above high-leverage ones", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addRecommendation(projectId, {
      fingerprint: "rule:thin-content",
      priority: "MEDIUM",
      impact: 5,
      difficulty: 1,
      title: "Cheap win",
    });
    await addRecommendation(projectId, {
      fingerprint: "rule:blocked-ai-crawlers",
      ruleKey: "blocked-ai-crawlers",
      priority: "CRITICAL",
      impact: 5,
      difficulty: 5,
      title: "Unblock the crawlers",
    });

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/recommendations`,
        headers: { cookie },
      })
    ).json();

    expect(body.data[0].title).toBe("Unblock the crawlers");
  });

  it("filters by status and by priority", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addRecommendation(projectId, { fingerprint: "a", status: "OPEN" });
    await addRecommendation(projectId, { fingerprint: "b", status: "DONE", ruleKey: "orphan-pages" });

    const open = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/recommendations?status=OPEN`,
        headers: { cookie },
      })
    ).json();
    expect(open.data).toHaveLength(1);
    expect(open.data[0].status).toBe("OPEN");

    const critical = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/recommendations?priority=CRITICAL`,
        headers: { cookie },
      })
    ).json();
    expect(critical.data).toEqual([]);
  });

  it("pages with a cursor", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    for (let index = 0; index < 5; index += 1) {
      await addRecommendation(projectId, { fingerprint: `f${index}`, title: `Card ${index}` });
    }

    const first = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/recommendations?limit=2`,
        headers: { cookie },
      })
    ).json();
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/recommendations?limit=2&cursor=${first.nextCursor}`,
        headers: { cookie },
      })
    ).json();
    expect(second.data[0].id).not.toBe(first.data[0].id);
  });

  it("404s another user's list", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/recommendations`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /recommendations/{id}", () => {
  it("expands the body, the rule key and the evidence", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const recId = await addRecommendation(projectId);

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/recommendations/${recId}`,
        headers: { cookie },
      })
    ).json();

    expect(body.ruleKey).toBe("thin-content");
    expect(body.body).toContain("too short");
    expect(body.evidence.snapshotIds).toEqual(["snap-1"]);
  });

  it("404s a recommendation from another project", async () => {
    const cookie = await signUp();
    const mine = await createProject(cookie);
    const other = await signUp("other@acme.test");
    const theirs = await createProject(other);
    const recId = await addRecommendation(theirs);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${mine}/recommendations/${recId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("PATCH /recommendations/{id} — the transition matrix", () => {
  const allowed: ReadonlyArray<[string, string]> = [
    ["OPEN", "DONE"],
    ["OPEN", "DISMISSED"],
    ["DONE", "OPEN"],
    ["DISMISSED", "OPEN"],
    ["VALIDATED", "OPEN"],
    ["REGRESSED", "DONE"],
    ["REGRESSED", "DISMISSED"],
  ];

  for (const [from, to] of allowed) {
    it(`allows ${from} → ${to}`, async () => {
      const cookie = await signUp();
      const projectId = await createProject(cookie);
      const recId = await addRecommendation(projectId, {
        status: from as "OPEN" | "DONE" | "DISMISSED" | "VALIDATED" | "REGRESSED",
      });

      const response = await patchStatus(cookie, projectId, recId, to);

      expect(response.statusCode, `${from} → ${to}`).toBe(200);
      expect(response.json().status).toBe(to);
    });
  }

  const refused: ReadonlyArray<[string, string]> = [
    ["DONE", "DISMISSED"],
    ["DISMISSED", "DONE"],
    ["VALIDATED", "DONE"],
  ];

  for (const [from, to] of refused) {
    it(`refuses ${from} → ${to}`, async () => {
      const cookie = await signUp();
      const projectId = await createProject(cookie);
      const recId = await addRecommendation(projectId, {
        status: from as "OPEN" | "DONE" | "DISMISSED" | "VALIDATED" | "REGRESSED",
      });

      const response = await patchStatus(cookie, projectId, recId, to);

      expect(response.statusCode, `${from} → ${to}`).toBe(400);
      expect(response.json().code).toBe("VALIDATION_FAILED");
    });
  }

  for (const status of ["VALIDATED", "REGRESSED"]) {
    it(`refuses a client setting ${status} — the pipeline owns it`, async () => {
      const cookie = await signUp();
      const projectId = await createProject(cookie);
      const recId = await addRecommendation(projectId);

      const response = await patchStatus(cookie, projectId, recId, status);

      expect(response.statusCode).toBe(400);
      // Rejected by the body schema at the edge, before any use case runs.
      expect(response.json().code).toBe("VALIDATION_FAILED");
      const unchanged = await harness.prisma.recommendation.findUniqueOrThrow({
        where: { id: recId },
      });
      expect(unchanged.status).toBe("OPEN");
    });
  }

  it("records when a card was marked done, and clears it on reopen", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const recId = await addRecommendation(projectId);

    await patchStatus(cookie, projectId, recId, "DONE");
    const done = await harness.prisma.recommendation.findUniqueOrThrow({ where: { id: recId } });
    expect(done.resolvedAt).not.toBeNull();

    await patchStatus(cookie, projectId, recId, "OPEN");
    const reopened = await harness.prisma.recommendation.findUniqueOrThrow({ where: { id: recId } });
    expect(reopened.resolvedAt).toBeNull();
  });

  it("treats setting the same status again as a no-op, not an error", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const recId = await addRecommendation(projectId);

    expect((await patchStatus(cookie, projectId, recId, "OPEN")).statusCode).toBe(200);
  });

  it("rejects a status outside the enum entirely", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const recId = await addRecommendation(projectId);

    expect((await patchStatus(cookie, projectId, recId, "ARCHIVED")).statusCode).toBe(400);
  });

  it("requires a session", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const recId = await addRecommendation(projectId);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/recommendations/${recId}`,
      payload: { status: "DONE" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s another user's card rather than confirming it exists", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const recId = await addRecommendation(projectId);
    const stranger = await signUp("stranger@rival.test");

    expect((await patchStatus(stranger, projectId, recId, "DONE")).statusCode).toBe(404);
  });
});

describe("the dashboard block", () => {
  it("carries the top open cards", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addRecommendation(projectId, {
      fingerprint: "rule:blocked-ai-crawlers",
      ruleKey: "blocked-ai-crawlers",
      priority: "CRITICAL",
      title: "Unblock the crawlers",
    });
    await addRecommendation(projectId, {
      fingerprint: "rule:done",
      status: "DONE",
      title: "Already handled",
    });

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/dashboard`,
        headers: { cookie },
      })
    ).json();

    expect(body.topRecommendations).toHaveLength(1);
    expect(body.topRecommendations[0].title).toBe("Unblock the crawlers");
  });
});
