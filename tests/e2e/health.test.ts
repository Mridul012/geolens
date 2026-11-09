import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";

describe("GET /health", () => {
  let harness: TestApp;

  beforeAll(async () => {
    harness = await buildTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("returns 200 with no dependencies registered", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", process: "api", checks: [] });
  });

  it("carries a request id on every response", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it("returns problem+json with a stable code for an unknown route", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      title: "Not found",
    });
    expect(response.json().requestId).toMatch(/^req_/);
  });
});
