/**
 * M4 acceptance: the full project lifecycle, the ownership guard's 404-not-403 semantics,
 * plan limits, and URL validation — proven through the real HTTP surface.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, cookieHeaderFrom, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let harness: TestApp;

async function signUp(email: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: email.split("@")[0] },
  });
  expect(response.statusCode).toBe(200);
  return cookieHeaderFrom(response);
}

async function createProject(
  cookie: string,
  payload: Record<string, unknown> = { name: "Acme", url: "https://acme.com" },
): Promise<ReturnType<TestApp["app"]["inject"]>> {
  return harness.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { cookie },
    payload,
  });
}

async function upgradeToPro(email: string): Promise<void> {
  const user = await harness.prisma.user.findFirstOrThrow({ where: { email } });
  await harness.prisma.subscription.create({
    data: {
      userId: user.id,
      stripeCustomerId: `cus_${user.id}`,
      plan: "PRO",
      status: "ACTIVE",
    },
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

describe("project lifecycle", () => {
  it("creates → reads → patches → adds and removes a competitor", async () => {
    const cookie = await signUp("priya@acme.test");

    const created = await createProject(cookie, {
      name: "Acme",
      url: "WWW.Acme.com/",
      timezone: "Asia/Kolkata",
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.name).toBe("Acme");
    expect(project.timezone).toBe("Asia/Kolkata");
    expect(project.status).toBe("ACTIVE");
    // Normalization happens server-side: scheme defaulted, www dropped, slash removed.
    expect(project.sites).toHaveLength(1);
    expect(project.sites[0]).toMatchObject({
      url: "https://acme.com",
      domain: "acme.com",
      role: "OWN",
    });

    const detail = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    // No crawl has run yet — the contract's honest empty state, not a 404.
    expect(detail.json()).toMatchObject({ latestCrawl: null, latestScore: null });

    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${project.id}`,
      headers: { cookie },
      payload: { name: "Acme Inc", status: "ARCHIVED" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Acme Inc", status: "ARCHIVED" });

    const added = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
      payload: { url: "https://rival.com", name: "Rival" },
    });
    expect(added.statusCode).toBe(201);
    const competitor = added.json();
    expect(competitor).toMatchObject({ url: "https://rival.com", role: "COMPETITOR", name: "Rival" });

    const listed = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
    });
    expect(listed.json().data).toHaveLength(1);

    const removed = await harness.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}/competitors/${competitor.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    const afterRemoval = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
    });
    expect(afterRemoval.json().data).toHaveLength(0);
  });

  it("creates the competitor alongside the own site in one call", async () => {
    const cookie = await signUp("priya@acme.test");
    const created = await createProject(cookie, {
      name: "Acme",
      url: "https://acme.com",
      competitorUrl: "https://rival.com",
    });
    expect(created.statusCode).toBe(201);
    const roles = created.json().sites.map((s: { role: string }) => s.role).sort();
    expect(roles).toEqual(["COMPETITOR", "OWN"]);
  });

  it("lists projects with a cursor page shape", async () => {
    const cookie = await signUp("priya@acme.test");
    await upgradeToPro("priya@acme.test");
    await createProject(cookie, { name: "One", url: "https://one.com" });
    await createProject(cookie, { name: "Two", url: "https://two.com" });

    const response = await harness.app.inject({
      method: "GET",
      url: "/v1/projects?limit=1",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();

    const next = await harness.app.inject({
      method: "GET",
      url: `/v1/projects?limit=1&cursor=${body.nextCursor}`,
      headers: { cookie },
    });
    expect(next.json().data).toHaveLength(1);
    expect(next.json().data[0].id).not.toBe(body.data[0].id);
  });

  it("soft-deletes with 202 PURGE_SCHEDULED and hides the project from reads", async () => {
    const cookie = await signUp("priya@acme.test");
    const project = (await createProject(cookie)).json();

    const deleted = await harness.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(202);
    expect(deleted.json()).toEqual({ status: "PURGE_SCHEDULED" });

    // Soft delete: the row survives for the batched purge, but no read can reach it.
    const row = await harness.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(row.deletedAt).not.toBeNull();

    const detail = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(404);

    const list = await harness.app.inject({ method: "GET", url: "/v1/projects", headers: { cookie } });
    expect(list.json().data).toHaveLength(0);
  });
});

describe("ownership guard", () => {
  it("returns 404, never 403, for another user's project", async () => {
    const owner = await signUp("owner@acme.test");
    const project = (await createProject(owner)).json();
    const stranger = await signUp("stranger@rival.test");

    const paths = [
      { method: "GET" as const, url: `/v1/projects/${project.id}` },
      { method: "PATCH" as const, url: `/v1/projects/${project.id}`, payload: { name: "Mine now" } },
      { method: "DELETE" as const, url: `/v1/projects/${project.id}` },
      { method: "GET" as const, url: `/v1/projects/${project.id}/competitors` },
      {
        method: "POST" as const,
        url: `/v1/projects/${project.id}/competitors`,
        payload: { url: "https://evil.com" },
      },
    ];

    for (const path of paths) {
      const response = await harness.app.inject({ ...path, headers: { cookie: stranger } });
      expect(response.statusCode, `${path.method} ${path.url}`).toBe(404);
      expect(response.json().code).toBe("NOT_FOUND");
    }

    // And nothing was mutated.
    const stillOwned = await harness.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stillOwned.name).toBe("Acme");
    expect(stillOwned.deletedAt).toBeNull();
  });

  it("answers a missing project and a stranger's project identically", async () => {
    const owner = await signUp("owner@acme.test");
    const project = (await createProject(owner)).json();
    const stranger = await signUp("stranger@rival.test");

    const notYours = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}`,
      headers: { cookie: stranger },
    });
    const missing = await harness.app.inject({
      method: "GET",
      url: "/v1/projects/00000000-0000-4000-8000-000000000000",
      headers: { cookie: stranger },
    });

    expect(notYours.statusCode).toBe(missing.statusCode);
    expect(notYours.json().code).toBe(missing.json().code);
    expect(notYours.json().detail).toBe(missing.json().detail);
  });

  it("requires a session", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/v1/projects" });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_REQUIRED");
  });
});

describe("plan limits", () => {
  it("refuses a second project on FREE with PLAN_LIMIT_EXCEEDED", async () => {
    const cookie = await signUp("priya@acme.test");
    expect((await createProject(cookie, { name: "One", url: "https://one.com" })).statusCode).toBe(201);

    const second = await createProject(cookie, { name: "Two", url: "https://two.com" });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({ code: "PLAN_LIMIT_EXCEEDED", status: 403 });
    expect(second.json().detail).toContain("1 project");
  });

  it("allows three projects on PRO and refuses the fourth", async () => {
    const cookie = await signUp("priya@acme.test");
    await upgradeToPro("priya@acme.test");

    for (const n of [1, 2, 3]) {
      const response = await createProject(cookie, { name: `P${n}`, url: `https://site${n}.com` });
      expect(response.statusCode, `project ${n}`).toBe(201);
    }
    const fourth = await createProject(cookie, { name: "P4", url: "https://site4.com" });
    expect(fourth.statusCode).toBe(403);
  });

  it("refuses a second competitor", async () => {
    const cookie = await signUp("priya@acme.test");
    const project = (await createProject(cookie)).json();

    const first = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
      payload: { url: "https://rival.com" },
    });
    expect(first.statusCode).toBe(201);

    const second = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
      payload: { url: "https://other-rival.com" },
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("counts only live projects — a deleted one frees the slot", async () => {
    const cookie = await signUp("priya@acme.test");
    const project = (await createProject(cookie, { name: "One", url: "https://one.com" })).json();
    await harness.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}`,
      headers: { cookie },
    });

    const replacement = await createProject(cookie, { name: "Two", url: "https://two.com" });
    expect(replacement.statusCode).toBe(201);
  });
});

describe("URL validation", () => {
  it.each([
    ["http://localhost:3000", "loopback"],
    ["http://127.0.0.1", "loopback ip"],
    ["http://169.254.169.254", "cloud metadata"],
    ["http://192.168.1.1", "private network"],
    ["ftp://acme.com", "non-http scheme"],
    ["https://acme.com:8080", "non-standard port"],
    ["not a url at all", "malformed"],
  ])("refuses %s (%s) with INVALID_URL", async (url) => {
    const cookie = await signUp("priya@acme.test");
    const response = await createProject(cookie, { name: "Bad", url });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_URL");
    expect(await harness.prisma.project.count()).toBe(0);
  });

  it("refuses a competitor that is the same site as your own", async () => {
    const cookie = await signUp("priya@acme.test");
    const response = await createProject(cookie, {
      name: "Acme",
      url: "https://acme.com",
      competitorUrl: "https://www.acme.com/",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_URL");
  });

  // With a one-competitor limit the plan gate fires before the duplicate check; the
  // `UNIQUE (project_id, url)` backstop itself is proven in the constraint suite.
  it("refuses a second competitor even when it duplicates the first", async () => {
    const cookie = await signUp("priya@acme.test");
    const project = (await createProject(cookie)).json();
    await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
      payload: { url: "https://rival.com" },
    });
    const duplicate = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/competitors`,
      headers: { cookie },
      payload: { url: "https://www.rival.com/" },
    });
    expect(duplicate.statusCode).toBe(403);
  });

  it("rejects an invalid timezone on patch", async () => {
    const cookie = await signUp("priya@acme.test");
    const project = (await createProject(cookie)).json();
    const response = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${project.id}`,
      headers: { cookie },
      payload: { timezone: "Mars/Olympus_Mons" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });

  it("rejects an empty patch body", async () => {
    const cookie = await signUp("priya@acme.test");
    const project = (await createProject(cookie)).json();
    const response = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${project.id}`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("own site protection", () => {
  it("refuses to remove the OWN site through the competitors route", async () => {
    const cookie = await signUp("priya@acme.test");
    const project = (await createProject(cookie)).json();
    const ownSiteId = project.sites[0].id;

    const response = await harness.app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}/competitors/${ownSiteId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
    expect(await harness.prisma.site.count({ where: { role: "OWN" } })).toBe(1);
  });

  it("404s for a site id from another project", async () => {
    const cookie = await signUp("priya@acme.test");
    await upgradeToPro("priya@acme.test");
    const a = (await createProject(cookie, { name: "A", url: "https://a.com" })).json();
    const b = (await createProject(cookie, { name: "B", url: "https://b.com" })).json();

    const response = await harness.app.inject({
      method: "DELETE",
      url: `/v1/projects/${a.id}/competitors/${b.sites[0].id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
