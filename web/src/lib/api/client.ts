import type { Problem } from "@contracts/api/errors";

/** Exported for the rare caller that needs the raw origin: native `<a>` downloads (the
 * report PDF's 302-to-signed-URL flow must not go through `fetch`) and `EventSource`,
 * which has no fetch-style options object to carry a base URL through. */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.problem = problem;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  idempotencyKey?: string;
}

function isProblem(value: unknown): value is Problem {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

/**
 * Thin fetch wrapper for the Fastify API. Client Components rely on the browser sending
 * the session cookie via `credentials: "include"`; Server Components must pass a `Cookie`
 * header explicitly (see `./server.ts`) since there is no browser cookie jar on the server.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, idempotencyKey, headers: headersInit, ...rest } = options;
  const headers = new Headers(headersInit);
  const hasBody = body !== undefined;
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers,
    credentials: "include",
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    if (isProblem(payload)) throw new ApiError(payload);
    throw new Error(`Request to ${path} failed with status ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
