import type { EventPayload } from "@contracts/api/snapshots";

/**
 * Shared by the History page's Server Component and its client view. It lives outside any
 * "use client" module on purpose: a value exported from one reaches a Server Component as
 * a client reference, not as the value.
 */
export const HISTORY_PAGE_SIZE = 20;

/** `GET /v1/projects/{id}/events` — newest first, cursor-paginated. */
export interface EventPage {
  readonly data: EventPayload[];
  readonly nextCursor: string | null;
}
