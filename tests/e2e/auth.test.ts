/**
 * Auth e2e — happy path and every documented failure (Engineering-Rules §9).
 * Real Better Auth, real Postgres; only the rate limiter is relaxed except where the test
 * is about rate limiting.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, cookieHeaderFrom, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let harness: TestApp;

const credentials = {
  email: "priya@acme.test",
  password: "correct-horse-battery",
  name: "Priya",
};

async function signUp(): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: credentials,
  });
  expect(response.statusCode).toBe(200);
  return cookieHeaderFrom(response);
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

describe("sign-up", () => {
  it("creates an account, sets a session cookie, and returns SessionInfo", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: credentials,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe(credentials.email);
    expect(body.user.name).toBe("Priya");
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(body.session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const cookies = response.headers["set-cookie"];
    expect(String(cookies)).toContain("vryse.session");
    expect(String(cookies)).toContain("HttpOnly");
    expect(String(cookies)).toContain("SameSite=Lax");
  });

  it("stores the credential on the account row, never in plain text", async () => {
    await signUp();
    const account = await harness.prisma.oauthAccount.findFirstOrThrow();
    expect(account.provider).toBe("credential");
    expect(account.password).not.toBeNull();
    expect(account.password).not.toContain(credentials.password);
  });

  it("rejects a duplicate email with EMAIL_IN_USE", async () => {
    await signUp();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: credentials,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMAIL_IN_USE", status: 409 });
  });

  it("rejects a short password with field-level detail", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { ...credentials, password: "short" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.errors.some((e: { path: string }) => e.path === "password")).toBe(true);
  });

  it("rejects a malformed email", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { ...credentials, email: "not-an-email" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });
});

describe("sign-in", () => {
  it("returns a session for correct credentials", async () => {
    await signUp();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: credentials.email, password: credentials.password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe(credentials.email);
  });

  it("returns 401 INVALID_CREDENTIALS in problem+json with a requestId", async () => {
    await signUp();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: credentials.email, password: "wrong-password-entirely" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const body = response.json();
    expect(body).toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
      title: "Invalid credentials",
    });
    expect(body.requestId).toMatch(/^req_/);
    expect(body.type).toContain("/errors/invalid-credentials");
  });

  it("gives an unknown email the same answer as a wrong password (no enumeration oracle)", async () => {
    await signUp();
    const wrongPassword = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: credentials.email, password: "wrong-password-entirely" },
    });
    const unknownUser = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: "nobody@acme.test", password: "wrong-password-entirely" },
    });

    expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownUser.json().code).toBe(wrongPassword.json().code);
    expect(unknownUser.json().detail).toBe(wrongPassword.json().detail);
  });
});

describe("session lifecycle", () => {
  it("GET /v1/auth/session returns the session for a signed-in caller", async () => {
    const cookie = await signUp();
    const response = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe(credentials.email);
  });

  it("GET /v1/auth/session returns 401 AUTH_REQUIRED without a cookie", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/v1/auth/session" });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_REQUIRED");
  });

  it("sign-out revokes the session server-side", async () => {
    const cookie = await signUp();
    expect(await harness.prisma.session.count()).toBe(1);

    const signOut = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-out",
      headers: { cookie, origin: "http://localhost:3001" },
    });
    expect(signOut.statusCode).toBe(200);
    expect(await harness.prisma.session.count()).toBe(0);

    const afterward = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie },
    });
    expect(afterward.statusCode).toBe(401);
  });

  it("an expired session no longer authenticates", async () => {
    const cookie = await signUp();
    await harness.prisma.session.updateMany({
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const response = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /v1/me", () => {
  it("returns the profile with FREE plan usage against limits", async () => {
    const cookie = await signUp();
    const response = await harness.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      email: credentials.email,
      name: "Priya",
      plan: "FREE",
      usage: {
        projects: { used: 0, limit: 1 },
        activePrompts: { used: 0, limit: 10 },
        // Open Question #3 resolved: FREE curates prompts, runs are the paid unlock.
        onDemandRunsThisWeek: { used: 0, limit: 0 },
      },
    });
  });

  it("reports PRO limits once the subscription is active", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow();
    await harness.prisma.subscription.create({
      data: {
        userId: user.id,
        stripeCustomerId: "cus_test_pro",
        plan: "PRO",
        status: "ACTIVE",
      },
    });

    const response = await harness.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(response.json()).toMatchObject({
      plan: "PRO",
      usage: {
        projects: { used: 0, limit: 3 },
        onDemandRunsThisWeek: { used: 0, limit: 1 },
      },
    });
  });

  it("falls back to FREE entitlements when a subscription is past due", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow();
    await harness.prisma.subscription.create({
      data: {
        userId: user.id,
        stripeCustomerId: "cus_test_pastdue",
        plan: "PRO",
        status: "PAST_DUE",
      },
    });

    const response = await harness.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(response.json().plan).toBe("FREE");
  });

  it("returns 401 without a session", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/v1/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_REQUIRED");
  });
});

describe("social sign-in", () => {
  it("reports a clear validation error when Google is not configured", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/social",
      payload: { provider: "google" },
    });
    // Locally and in CI no Google credentials exist; the contract's 400 is the honest
    // answer, not a 500.
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });

  it("rejects an unsupported provider", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/social",
      payload: { provider: "myspace" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });
});
