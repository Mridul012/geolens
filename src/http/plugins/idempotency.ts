/**
 * Idempotency for the three async triggers (docs/API.md §1, §4.4).
 *
 * A thin seam over the store so routes read as prose and the store stays swappable. The
 * conflict case throws the documented `409 IDEMPOTENCY_KEY_REUSED` rather than returning a
 * value, because there is no sensible response to give a client that reused a key with a
 * different payload.
 */
import { idempotencyKeyReused } from "../../domain/shared/app-error.js";

export interface IdempotencyStore {
  claim(
    scope: string,
    userId: string,
    key: string,
    payload: unknown,
  ): Promise<{ kind: "fresh" } | { kind: "replay"; response: unknown } | { kind: "conflict" }>;
  complete(
    scope: string,
    userId: string,
    key: string,
    payload: unknown,
    response: unknown,
  ): Promise<void>;
  release(scope: string, userId: string, key: string): Promise<void>;
}

export interface IdempotencyGate {
  /**
   * Claims the key. Returns the original response for a replay, `null` to proceed, and
   * throws `IDEMPOTENCY_KEY_REUSED` when the same key arrives with a different payload.
   */
  begin(scope: string, userId: string, key: string, payload: unknown): Promise<unknown | null>;
  finish(
    scope: string,
    userId: string,
    key: string,
    payload: unknown,
    response: unknown,
  ): Promise<void>;
  /** Releases a claim whose request failed, so an honest retry is possible. */
  abandon(scope: string, userId: string, key: string): Promise<void>;
}

export function createIdempotencyGate(store: IdempotencyStore): IdempotencyGate {
  return {
    begin: async (scope, userId, key, payload) => {
      const outcome = await store.claim(scope, userId, key, payload);
      if (outcome.kind === "conflict") throw idempotencyKeyReused();
      if (outcome.kind === "replay") {
        // A replay arriving before the first request finished has no stored response yet.
        // Proceeding would double-create, so treat it as a conflict-free no-op and let the
        // caller's own state checks (the active-crawl 409) settle it.
        return outcome.response ?? null;
      }
      return null;
    },
    finish: (scope, userId, key, payload, response) =>
      store.complete(scope, userId, key, payload, response),
    abandon: (scope, userId, key) => store.release(scope, userId, key),
  };
}
