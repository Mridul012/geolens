import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError } from "@/lib/api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always sends credentials so the session cookie travels cross-origin", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));

    await apiFetch("/v1/me");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/v1/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("JSON-encodes a body and sets content-type only when a body is present", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { id: "1" }));

    await apiFetch("/v1/projects", { method: "POST", body: { name: "Acme" } });

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(init?.body).toBe(JSON.stringify({ name: "Acme" }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("omits a body and content-type for a bodyless request", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    await apiFetch("/v1/me");

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("sets the Idempotency-Key header when one is given", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(202, { id: "crawl_1" }));

    await apiFetch("/v1/projects/p1/crawls", {
      method: "POST",
      body: {},
      idempotencyKey: "11111111-1111-1111-1111-111111111111",
    });

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("returns undefined for a 204 with no body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch("/v1/projects/p1/competitors/s1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("returns the parsed JSON body on success", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { plan: "FREE" }));

    await expect(apiFetch("/v1/me")).resolves.toEqual({ plan: "FREE" });
  });

  it("throws an ApiError carrying the RFC-7807 problem on a non-ok response", async () => {
    const problem = {
      title: "Plan limit exceeded",
      status: 403,
      code: "PLAN_LIMIT_EXCEEDED",
      detail: "Free plan allows 1 project.",
      requestId: "req_1",
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, problem));

    const error = await apiFetch("/v1/projects", { method: "POST", body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).problem).toEqual(problem);
    expect((error as ApiError).message).toBe(problem.detail);
  });

  it("falls back to a plain Error when a non-ok response isn't problem+json shaped", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const error = await apiFetch("/v1/me").catch((e) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).message).toContain("502");
  });
});
