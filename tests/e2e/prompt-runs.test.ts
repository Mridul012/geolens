/**
 * Prompt-run endpoints over HTTP (M15 acceptance, docs/API.md §3).
 *
 * A run spends real money at real providers, so the guards on the trigger are the point:
 * a required idempotency key, one active run per project, and an on-demand quota that
 * resolves PRD Open Question #3 — FREE curates prompts, PRO spends on demand.
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

/** Upgrades the account, since FREE deliberately has no on-demand run quota. */
async function upgrade(email = "priya@acme.test"): Promise<void> {
  const user = await harness.prisma.user.findFirstOrThrow({ where: { email } });
  await harness.prisma.subscription.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      stripeCustomerId: `cus_${user.id.slice(0, 8)}`,
      plan: "PRO",
      status: "ACTIVE",
    },
    update: { plan: "PRO", status: "ACTIVE" },
  });
}

async function addPrompt(projectId: string, index = 0): Promise<string> {
  const row = await harness.prisma.promptTemplate.create({
    data: {
      projectId,
      text: `best analytics tool for finance teams number ${index}`,
      intent: "recommendation",
      source: "GENERATED",
      position: index,
    },
  });
  return row.id;
}

async function trigger(cookie: string, projectId: string, key = "run-key-1") {
  return harness.app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/prompt-runs`,
    headers: { cookie, "idempotency-key": key },
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

describe("POST /prompt-runs", () => {
  it("queues a run with 202 and a Location header", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();
    await addPrompt(projectId);

    const response = await trigger(cookie, projectId);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "QUEUED", trigger: "MANUAL" });
    expect(response.headers["location"]).toContain(`/prompt-runs/${response.json().id}`);
    expect(harness.enqueued().some((job) => job.queue === "prompt-sim")).toBe(true);
  });

  it("requires an Idempotency-Key", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();
    await addPrompt(projectId);

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/prompt-runs`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().errors[0].path).toBe("Idempotency-Key");
  });

  it("replays the same run for a repeated key rather than buying a second one", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();
    await addPrompt(projectId);

    const first = await trigger(cookie, projectId, "same-key");
    const second = await trigger(cookie, projectId, "same-key");

    expect(second.statusCode).toBe(202);
    expect(second.json().id).toBe(first.json().id);
    expect(await harness.prisma.promptRun.count()).toBe(1);
  });

  it("409s a second run while one is active", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();
    await addPrompt(projectId);
    await trigger(cookie, projectId, "key-a");

    const second = await trigger(cookie, projectId, "key-b");

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("PROMPT_RUN_ALREADY_ACTIVE");
  });

  it("404s a project with no tracked prompts — a run with nothing to ask", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();

    expect((await trigger(cookie, projectId)).statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/prompt-runs`,
      headers: { "idempotency-key": "k" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s another user's project", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    await upgrade("owner@acme.test");
    await addPrompt(projectId);
    const stranger = await signUp("stranger@rival.test");

    expect((await trigger(stranger, projectId)).statusCode).toBe(404);
  });
});

describe("the on-demand quota", () => {
  it("refuses a FREE account, and says why", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await addPrompt(projectId);

    const response = await trigger(cookie, projectId);

    expect(PLAN_LIMITS.FREE.onDemandRunsPerWeek).toBe(0);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PLAN_LIMIT_EXCEEDED");
    // The message has to explain that scheduled runs still happen — otherwise it reads as
    // "prompt tracking is not available", which is not what the plan says.
    expect(response.json().detail).toContain("scheduled");
  });

  it("allows a PRO account its weekly run", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();
    await addPrompt(projectId);

    expect(PLAN_LIMITS.PRO.onDemandRunsPerWeek).toBe(1);
    expect((await trigger(cookie, projectId)).statusCode).toBe(202);
  });

  it("refuses a second on-demand run inside the same week", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();
    await addPrompt(projectId);
    const first = await trigger(cookie, projectId, "key-a");

    // The first run has to finish, or the 409 would mask the quota check.
    await harness.prisma.promptRun.update({
      where: { id: first.json().id },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });

    const second = await trigger(cookie, projectId, "key-b");

    expect(second.statusCode).toBe(403);
    expect(second.json().code).toBe("PLAN_LIMIT_EXCEEDED");
  });

  it("does not count a run from more than a week ago", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await upgrade();
    await addPrompt(projectId);
    const site = await harness.prisma.site.findFirstOrThrow({ where: { projectId } });
    expect(site.projectId).toBe(projectId);

    await harness.prisma.promptRun.create({
      data: {
        projectId,
        trigger: "MANUAL",
        status: "COMPLETED",
        engines: ["perplexity"],
        finishedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });

    expect((await trigger(cookie, projectId)).statusCode).toBe(202);
  });
});

describe("reading runs", () => {
  async function completedRun(projectId: string, composite = { mention: 60, citation: 40 }) {
    return harness.prisma.promptRun.create({
      data: {
        projectId,
        trigger: "MANUAL",
        status: "COMPLETED",
        engines: ["perplexity", "openai"],
        mentionRate: composite.mention,
        citationShare: composite.citation,
        metrics: {
          perEngine: [
            { engine: "perplexity", mentionRate: 80, citationShare: 60 },
            { engine: "openai", mentionRate: 40, citationShare: 20 },
          ],
        },
        finishedAt: new Date(),
      },
    });
  }

  it("lists runs newest first", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completedRun(projectId, { mention: 10, citation: 5 });
    const latest = await completedRun(projectId, { mention: 70, citation: 50 });

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompt-runs`,
        headers: { cookie },
      })
    ).json();

    expect(body.data[0].id).toBe(latest.id);
    expect(body.data[0].mentionRate).toBe(70);
  });

  it("serves a run's detail with its per-engine breakdown", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const run = await completedRun(projectId);

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompt-runs/${run.id}`,
        headers: { cookie },
      })
    ).json();

    expect(body.status).toBe("COMPLETED");
    expect(body.metrics.perEngine).toHaveLength(2);
  });

  it("serves the trend oldest first, with per-engine points", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completedRun(projectId, { mention: 10, citation: 5 });
    await completedRun(projectId, { mention: 70, citation: 50 });

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompt-runs/trend`,
        headers: { cookie },
      })
    ).json();

    expect(body.data.map((point: { mentionRate: number }) => point.mentionRate)).toEqual([10, 70]);
    expect(body.data[0].perEngine).toHaveLength(2);
    expect(body.data[0].perEngine[0].engine).toBe("perplexity");
  });

  it("omits a run still in flight from the trend", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    await completedRun(projectId);
    await harness.prisma.promptRun.create({
      data: { projectId, trigger: "MANUAL", status: "RUNNING", engines: ["perplexity"] },
    });

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompt-runs/trend`,
        headers: { cookie },
      })
    ).json();

    expect(body.data).toHaveLength(1);
  });

  it("serves per-cell results with the answer as evidence", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const run = await completedRun(projectId);
    const promptId = await addPrompt(projectId);
    await harness.prisma.promptResult.create({
      data: {
        promptRunId: run.id,
        promptTemplateId: promptId,
        engine: "perplexity",
        sampleIndex: 0,
        brandMentioned: true,
        brandCited: true,
        answerText: "Acme Analytics is the usual pick; see https://acme.com/pricing.",
        citations: ["https://acme.com/pricing"],
        model: "fake-engine-perplexity",
      },
    });

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompt-runs/${run.id}/results`,
        headers: { cookie },
      })
    ).json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].answerText).toContain("Acme Analytics");
    expect(body.data[0].citations).toEqual(["https://acme.com/pricing"]);
    // bigint, string-encoded — JSON cannot carry it otherwise.
    expect(typeof body.data[0].id).toBe("string");
  });

  it("filters results by engine", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const run = await completedRun(projectId);
    const promptId = await addPrompt(projectId);
    for (const engine of ["perplexity", "openai"]) {
      await harness.prisma.promptResult.create({
        data: {
          promptRunId: run.id,
          promptTemplateId: promptId,
          engine,
          sampleIndex: 0,
          model: `fake-engine-${engine}`,
        },
      });
    }

    const body = (
      await harness.app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/prompt-runs/${run.id}/results?engine=openai`,
        headers: { cookie },
      })
    ).json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].engine).toBe("openai");
  });

  it("404s a run from another project", async () => {
    const cookie = await signUp();
    const mine = await createProject(cookie);
    const other = await signUp("other@acme.test");
    const theirs = await createProject(other);
    const run = await completedRun(theirs);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${mine}/prompt-runs/${run.id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not let /trend be swallowed by the :runId route", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/prompt-runs/trend`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("the progress stream", () => {
  it("emits progress and closes when the run finishes", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const run = await harness.prisma.promptRun.create({
      data: {
        projectId,
        trigger: "MANUAL",
        status: "COMPLETED",
        engines: ["perplexity"],
        finishedAt: new Date(),
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/prompt-runs/${run.id}/progress`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    // Postgres is authoritative: a run already terminal closes the stream immediately
    // rather than hanging on a Redis hash that may never be written.
    expect(response.body).toContain("event: done");
    expect(response.body).toContain("COMPLETED");
  });

  // Regression: the stream wrote its response head on the raw socket with only its own
  // headers, dropping the CORS headers @fastify/cors had queued — so the web app (a
  // different origin) could never read live progress in a browser.
  it("carries CORS and security headers for the web app's origin", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const run = await harness.prisma.promptRun.create({
      data: {
        projectId,
        trigger: "MANUAL",
        status: "COMPLETED",
        engines: ["perplexity"],
        finishedAt: new Date(),
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/prompt-runs/${run.id}/progress`,
      headers: { cookie, origin: "http://localhost:3001" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("never grants a disallowed origin access to the stream", async () => {
    const cookie = await signUp();
    const projectId = await createProject(cookie);
    const run = await harness.prisma.promptRun.create({
      data: {
        projectId,
        trigger: "MANUAL",
        status: "COMPLETED",
        engines: ["perplexity"],
        finishedAt: new Date(),
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/prompt-runs/${run.id}/progress`,
      headers: { cookie, origin: "https://evil.example" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("404s another user's run", async () => {
    const owner = await signUp("owner@acme.test");
    const projectId = await createProject(owner);
    const run = await harness.prisma.promptRun.create({
      data: { projectId, trigger: "MANUAL", status: "RUNNING", engines: ["perplexity"] },
    });
    const stranger = await signUp("stranger@rival.test");

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/prompt-runs/${run.id}/progress`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(404);
  });
});
