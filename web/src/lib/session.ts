import "server-only";
import type { SessionInfo } from "@contracts/api/auth";
import { ApiError } from "./api/client";
import { apiFetchServer } from "./api/server";

/** Null means "not signed in" — every other failure still throws. */
export async function getSession(): Promise<SessionInfo | null> {
  try {
    return await apiFetchServer<SessionInfo>("/v1/auth/session");
  } catch (error) {
    if (error instanceof ApiError && error.problem.code === "AUTH_REQUIRED") return null;
    throw error;
  }
}
