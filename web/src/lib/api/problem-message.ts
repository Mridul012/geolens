import { ApiError } from "./client";

/**
 * The most specific human-readable text an API failure carries. A `VALIDATION_FAILED`
 * problem often has no `detail` and puts the real reason in its field errors (e.g. "Google
 * sign-in is not configured."), so those win over the generic title.
 */
export function problemMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const fieldMessages = error.problem.errors?.map((entry) => entry.message) ?? [];
    if (fieldMessages.length > 0) return fieldMessages.join(" ");
    return error.problem.detail ?? error.problem.title;
  }
  return "Something went wrong. Please try again.";
}
