/**
 * The topics surface (M9 acceptance): topics are editable via the API, and a duplicate
 * active label is refused case-insensitively.
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

async function addTopic(cookie: string, projectId: string, payload: Record<string, unknown>) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/topics`,
    headers: { cookie },
    payload,
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

describe("topics lifecycle", () => {
  it("adds, lists, edits, reorders and archives", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const created = await addTopic(cookie, projectId, {
      label: "Pricing pages",
      description: "What the product costs and how plans compare.",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      label: "Pricing pages",
      source: "USER",
      status: "ACTIVE",
      position: 0,
    });

    const listed = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/topics`,
      headers: { cookie },
    });
    expect(listed.json().data).toHaveLength(1);

    const renamed = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${created.json().id}`,
      headers: { cookie },
      payload: { label: "Pricing and plans", position: 3 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ label: "Pricing and plans", position: 3 });

    const archived = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${created.json().id}`,
      headers: { cookie },
      payload: { status: "ARCHIVED" },
    });
    expect(archived.json().status).toBe("ARCHIVED");

    const active = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/topics?status=ACTIVE`,
      headers: { cookie },
    });
    expect(active.json().data).toHaveLength(0);
  });
});

describe("duplicate labels", () => {
  it("refuses a duplicate active label, ignoring case and surrounding space", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    expect((await addTopic(cookie, projectId, { label: "Pricing Pages" })).statusCode).toBe(201);

    for (const label of ["Pricing Pages", "pricing pages", "  PRICING PAGES  "]) {
      const duplicate = await addTopic(cookie, projectId, { label });
      expect(duplicate.statusCode, label).toBe(400);
      expect(duplicate.json().code).toBe("VALIDATION_FAILED");
      expect(duplicate.json().errors[0].path).toBe("label");
    }

    expect(await harness.prisma.topic.count()).toBe(1);
  });

  it("frees the label once the first topic is archived", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const first = await addTopic(cookie, projectId, { label: "Pricing pages" });

    await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${first.json().id}`,
      headers: { cookie },
      payload: { status: "ARCHIVED" },
    });

    const second = await addTopic(cookie, projectId, { label: "pricing pages" });
    expect(second.statusCode).toBe(201);
  });

  it("refuses a rename that collides with another active topic", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addTopic(cookie, projectId, { label: "Pricing" });
    const second = await addTopic(cookie, projectId, { label: "Security" });

    const collision = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${second.json().id}`,
      headers: { cookie },
      payload: { label: "pricing" },
    });
    expect(collision.statusCode).toBe(400);
  });

  it("allows renaming a topic to its own label", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const topic = await addTopic(cookie, projectId, { label: "Pricing" });

    const same = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${topic.json().id}`,
      headers: { cookie },
      payload: { label: "Pricing", description: "Updated description." },
    });
    expect(same.statusCode).toBe(200);
  });

  it("lets two different projects use the same label", async () => {
    const cookie = await signUp();
    const first = await createProject(cookie);
    const user = await harness.prisma.user.findFirstOrThrow();
    await harness.prisma.subscription.create({
      data: { userId: user.id, stripeCustomerId: "cus_topics", plan: "PRO", status: "ACTIVE" },
    });
    const secondProject = await harness.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Other", url: "https://other.com" },
    });

    expect((await addTopic(cookie, first, { label: "Pricing" })).statusCode).toBe(201);
    expect(
      (await addTopic(cookie, secondProject.json().id, { label: "Pricing" })).statusCode,
    ).toBe(201);
  });
});

describe("validation and access", () => {
  it("rejects an empty or whitespace label", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    expect((await addTopic(cookie, projectId, { label: "" })).statusCode).toBe(400);
    expect((await addTopic(cookie, projectId, { label: "   " })).statusCode).toBe(400);
  });

  it("rejects an empty patch body", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const topic = await addTopic(cookie, projectId, { label: "Pricing" });

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${topic.json().id}`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s another user's topics", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const topic = await addTopic(owner, projectId, { label: "Pricing" });
    const stranger = await signUp("stranger@rival.test");

    const list = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/topics`,
      headers: { cookie: stranger },
    });
    expect(list.statusCode).toBe(404);

    const patch = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/${topic.json().id}`,
      headers: { cookie: stranger },
      payload: { label: "Mine now" },
    });
    expect(patch.statusCode).toBe(404);
  });

  it("404s a topic from another project", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}/topics/00000000-0000-4000-8000-000000000000`,
      headers: { cookie },
      payload: { label: "Nope" },
    });
    expect(response.statusCode).toBe(404);
  });
});
