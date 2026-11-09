/**
 * Tracked prompt CRUD over HTTP (M14 acceptance, docs/API.md §3).
 *
 * The immutability rule is the one worth defending: editing a tracked prompt's wording
 * would silently corrupt its own trend line, because last month's mention rate would refer
 * to a different question and nothing on the chart would say so. Changing a prompt means
 * archive-and-create, and the API says so with a 403 rather than quietly ignoring the field.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "../../src/config/plans.js";
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

async function addPrompt(cookie: string, projectId: string, payload: Record<string, unknown>) {
  return harness.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/prompts`,
    headers: { cookie },
    payload,
  });
}

async function patchPrompt(
  cookie: string,
  projectId: string,
  promptId: string,
  payload: Record<string, unknown>,
) {
  return harness.app.inject({
    method: "PATCH",
    url: `/v1/projects/${projectId}/prompts/${promptId}`,
    headers: { cookie },
    payload,
  });
}

const PROMPT = "best invoice reconciliation tool for small finance teams";

beforeAll(async () => {
  harness = await buildTestApp();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.prisma);
});

describe("adding a prompt", () => {
  it("creates it and returns it", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await addPrompt(cookie, projectId, { text: PROMPT, intent: "recommendation" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      text: PROMPT,
      intent: "recommendation",
      source: "USER",
      status: "ACTIVE",
      pinned: false,
    });
  });

  it("rejects a prompt too short to ask anything", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    expect((await addPrompt(cookie, projectId, { text: "short" })).statusCode).toBe(400);
  });

  it("refuses a duplicate active prompt", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    expect((await addPrompt(cookie, projectId, { text: PROMPT })).statusCode).toBe(201);

    const duplicate = await addPrompt(cookie, projectId, { text: PROMPT });

    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().code).toBe("VALIDATION_FAILED");
    expect(await harness.prisma.promptTemplate.count()).toBe(1);
  });

  it("frees the text once the first is archived", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const first = await addPrompt(cookie, projectId, { text: PROMPT });
    await patchPrompt(cookie, projectId, first.json().id, { status: "ARCHIVED" });

    expect((await addPrompt(cookie, projectId, { text: PROMPT })).statusCode).toBe(201);
  });

  it("lets two projects track the same prompt", async () => {
    const cookie = await signUp();
    const first = await createProject(cookie);
    const user = await harness.prisma.user.findFirstOrThrow();
    await harness.prisma.subscription.create({
      data: { userId: user.id, stripeCustomerId: "cus_prompts", plan: "PRO", status: "ACTIVE" },
    });
    const second = await harness.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie },
      payload: { name: "Other", url: "https://other.com" },
    });

    expect((await addPrompt(cookie, first, { text: PROMPT })).statusCode).toBe(201);
    expect((await addPrompt(cookie, second.json().id, { text: PROMPT })).statusCode).toBe(201);
  });
});

describe("the plan limit", () => {
  const limit = PLAN_LIMITS.FREE.activePrompts;

  it(`refuses the ${limit + 1}th active prompt with 403`, async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    for (let index = 0; index < limit; index += 1) {
      expect((await addPrompt(cookie, projectId, { text: `${PROMPT} ${index}` })).statusCode).toBe(
        201,
      );
    }

    const over = await addPrompt(cookie, projectId, { text: `${PROMPT} extra` });

    // 403 with a code, not 402: this is an entitlement boundary, not a payment flow.
    expect(over.statusCode).toBe(403);
    expect(over.json().code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(await harness.prisma.promptTemplate.count()).toBe(limit);
  });

  it("counts only active prompts, so archiving makes room", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const ids: string[] = [];
    for (let index = 0; index < limit; index += 1) {
      ids.push((await addPrompt(cookie, projectId, { text: `${PROMPT} ${index}` })).json().id);
    }

    await patchPrompt(cookie, projectId, ids[0] as string, { status: "ARCHIVED" });

    expect((await addPrompt(cookie, projectId, { text: `${PROMPT} extra` })).statusCode).toBe(201);
  });

  it("refuses un-archiving when that would exceed the limit", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const ids: string[] = [];
    for (let index = 0; index < limit; index += 1) {
      ids.push((await addPrompt(cookie, projectId, { text: `${PROMPT} ${index}` })).json().id);
    }
    await patchPrompt(cookie, projectId, ids[0] as string, { status: "ARCHIVED" });
    await addPrompt(cookie, projectId, { text: `${PROMPT} replacement` });

    const restore = await patchPrompt(cookie, projectId, ids[0] as string, { status: "ACTIVE" });

    expect(restore.statusCode).toBe(403);
    expect(restore.json().code).toBe("PLAN_LIMIT_EXCEEDED");
  });
});

describe("immutability", () => {
  it("refuses a text edit with 403 PROMPT_TEXT_IMMUTABLE", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const created = await addPrompt(cookie, projectId, { text: PROMPT });

    const response = await patchPrompt(cookie, projectId, created.json().id, {
      text: "a completely different question",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PROMPT_TEXT_IMMUTABLE");
  });

  it("refuses it even alongside a legal field, and changes nothing", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const created = await addPrompt(cookie, projectId, { text: PROMPT });

    const response = await patchPrompt(cookie, projectId, created.json().id, {
      pinned: true,
      text: "sneaking an edit past a legal field",
    });

    expect(response.statusCode).toBe(403);
    const unchanged = await harness.prisma.promptTemplate.findUniqueOrThrow({
      where: { id: created.json().id },
    });
    expect(unchanged.text).toBe(PROMPT);
    expect(unchanged.pinned).toBe(false);
  });

  it("supports the documented archive-and-create flow instead", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const original = await addPrompt(cookie, projectId, { text: PROMPT });

    await patchPrompt(cookie, projectId, original.json().id, { status: "ARCHIVED" });
    const replacement = await addPrompt(cookie, projectId, {
      text: "best invoice reconciliation tool for enterprise finance teams",
    });

    expect(replacement.statusCode).toBe(201);
    // The archived prompt survives, so its results stay attached to the question that
    // produced them rather than to a question nobody ever asked.
    const archived = await harness.prisma.promptTemplate.findUniqueOrThrow({
      where: { id: original.json().id },
    });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.text).toBe(PROMPT);
  });
});

describe("curation", () => {
  it("pins, reorders and archives", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const created = await addPrompt(cookie, projectId, { text: PROMPT });
    const id = created.json().id;

    expect((await patchPrompt(cookie, projectId, id, { pinned: true })).json().pinned).toBe(true);
    expect((await patchPrompt(cookie, projectId, id, { position: 4 })).json().position).toBe(4);
    expect((await patchPrompt(cookie, projectId, id, { status: "ARCHIVED" })).json().status).toBe(
      "ARCHIVED",
    );
  });

  it("lists pinned prompts first", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addPrompt(cookie, projectId, { text: `${PROMPT} one` });
    const second = await addPrompt(cookie, projectId, { text: `${PROMPT} two` });
    await patchPrompt(cookie, projectId, second.json().id, { pinned: true });

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompts`,
        headers: { cookie },
      })
    ).json();

    expect(body.data[0].id).toBe(second.json().id);
  });

  it("filters by status", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const created = await addPrompt(cookie, projectId, { text: PROMPT });
    await patchPrompt(cookie, projectId, created.json().id, { status: "ARCHIVED" });

    const active = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompts?status=ACTIVE`,
        headers: { cookie },
      })
    ).json();
    expect(active.data).toEqual([]);

    const archived = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompts?status=ARCHIVED`,
        headers: { cookie },
      })
    ).json();
    expect(archived.data).toHaveLength(1);
  });

  it("rejects an empty patch", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const created = await addPrompt(cookie, projectId, { text: PROMPT });

    expect((await patchPrompt(cookie, projectId, created.json().id, {})).statusCode).toBe(400);
  });
});

describe("access", () => {
  it("requires a session", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/prompts`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s another user's prompts", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const created = await addPrompt(owner, projectId, { text: PROMPT });
    const stranger = await signUp("stranger@rival.test");

    const list = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/prompts`,
      headers: { cookie: stranger },
    });
    expect(list.statusCode).toBe(404);

    expect((await patchPrompt(stranger, projectId, created.json().id, { pinned: true })).statusCode).toBe(
      404,
    );
  });

  it("404s a prompt from another project", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await patchPrompt(
      cookie,
      projectId,
      "00000000-0000-4000-8000-000000000000",
      { pinned: true },
    );
    expect(response.statusCode).toBe(404);
  });
});
