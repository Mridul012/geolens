/**
 * The conventions every later route inherits (docs/API.md §1): CORS allowlist, the Origin
 * check on mutations, and RateLimit headers on every response. Proven once, here, so no
 * feature milestone has to re-prove them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let harness: TestApp;

beforeAll(async () => {
  harness = await buildTestApp({ useRealRedisRateLimiter: true });
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.prisma);
});

describe("Origin check on mutations", () => {
  const payload = { email: "origin@acme.test", password: "correct-horse-battery", name: "O" };

  it("accepts a mutation from an allowed origin", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      headers: { origin: "http://localhost:3001" },
      payload,
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects a mutation from a disallowed origin", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      headers: { origin: "https://evil.example" },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
    expect(await harness.prisma.user.count()).toBe(0);
  });

  it("allows a mutation with no Origin at all (same-origin or server-to-server)", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload,
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not gate reads on Origin", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("CORS", () => {
  it("echoes an allowed origin with credentials enabled", async () => {
    const response = await harness.app.inject({
      method: "OPTIONS",
      url: "/v1/me",
      headers: {
        origin: "http://localhost:3001",
        "access-control-request-method": "GET",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never answers a disallowed origin with a wildcard", async () => {
    const response = await harness.app.inject({
      method: "OPTIONS",
      url: "/v1/me",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("rate limiting", () => {
  it("sets RateLimit headers on every response", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/v1/me" });
    expect(response.headers["ratelimit-limit"]).toBeDefined();
    expect(response.headers["ratelimit-remaining"]).toBeDefined();
    expect(response.headers["ratelimit-reset"]).toBeDefined();
  });

  it("decrements remaining across consecutive requests", async () => {
    const first = await harness.app.inject({ method: "GET", url: "/v1/me" });
    const second = await harness.app.inject({ method: "GET", url: "/v1/me" });
    expect(Number(second.headers["ratelimit-remaining"])).toBeLessThan(
      Number(first.headers["ratelimit-remaining"]),
    );
  });

  it("exhausts the stricter auth bucket and answers 429 with Retry-After", async () => {
    let limited: Awaited<ReturnType<typeof harness.app.inject>> | undefined;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/auth/sign-in/email",
        payload: { email: "nobody@acme.test", password: "wrong-password-entirely" },
      });
      if (response.statusCode === 429) {
        limited = response;
        break;
      }
    }

    expect(limited, "auth bucket should exhaust within 15 attempts").toBeDefined();
    expect(limited?.json()).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(limited?.headers["retry-after"]).toBeDefined();
  });
});

describe("OpenAPI", () => {
  it("generates a spec from the runtime zod schemas", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toContain("/v1/me");
    expect(spec.components.securitySchemes.cookieAuth.name).toBe("vryse.session");
  });
});
