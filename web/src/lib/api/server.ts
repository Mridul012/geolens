import "server-only";
import { cookies } from "next/headers";
import { apiFetch, type ApiFetchOptions } from "./client";

/**
 * Server Components have no browser cookie jar, so the incoming request's session cookie
 * must be forwarded explicitly on every authenticated server-side call.
 */
export async function apiFetchServer<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const cookieStore = await cookies();
  const headers = new Headers(options.headers);
  const cookieHeader = cookieStore.toString();
  if (cookieHeader) headers.set("cookie", cookieHeader);
  return apiFetch<T>(path, { ...options, headers });
}
