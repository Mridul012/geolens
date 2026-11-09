/**
 * Idempotency keys for the three async triggers (docs/API.md §1).
 *
 * Double-clicks and mobile retries are the common case, not the edge case, which is why
 * the header is required rather than optional. A replay with the same key *and* the same
 * payload returns the original 202; the same key with a different payload is a client bug
 * and gets `409 IDEMPOTENCY_KEY_REUSED` rather than silently doing the wrong thing.
 *
 * Redis, with a 24-hour TTL: this is operational state, and losing it costs at worst a
 * duplicate crawl that the `one_active_crawl_per_site` constraint then refuses anyway.
 */
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

const TTL_SECONDS = 24 * 60 * 60;

export interface IdempotencyRecord {
  readonly payloadHash: string;
  readonly response: unknown;
}

export type IdempotencyOutcome =
  | { readonly kind: "fresh" }
  | { readonly kind: "replay"; readonly response: unknown }
  | { readonly kind: "conflict" };

function key(scope: string, userId: string, idempotencyKey: string): string {
  return `idem:${scope}:${userId}:${idempotencyKey}`;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

export class RedisIdempotencyStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /**
   * Claims a key for this payload.
   *
   * `SET NX` makes the claim atomic, so two simultaneous requests cannot both believe they
   * are first. The winner proceeds; the loser reads the stored record and either replays
   * it or reports a conflict.
   */
  async claim(
    scope: string,
    userId: string,
    idempotencyKey: string,
    payload: unknown,
  ): Promise<IdempotencyOutcome> {
    const redisKey = key(scope, userId, idempotencyKey);
    const payloadHash = hashPayload(payload);

    const claimed = await this.#redis.set(
      redisKey,
      JSON.stringify({ payloadHash, response: null }),
      "EX",
      TTL_SECONDS,
      "NX",
    );
    if (claimed === "OK") return { kind: "fresh" };

    const raw = await this.#redis.get(redisKey);
    if (raw === null) return { kind: "fresh" };

    const stored = JSON.parse(raw) as IdempotencyRecord;
    if (stored.payloadHash !== payloadHash) return { kind: "conflict" };
    // A replay that arrives before the first request finished has no response to return
    // yet; treating it as a conflict-free replay of `null` would be a lie, so the caller
    // waits for the original by re-reading the resource it names.
    return { kind: "replay", response: stored.response };
  }

  /** Stores the response so replays return exactly what the first call did. */
  async complete(
    scope: string,
    userId: string,
    idempotencyKey: string,
    payload: unknown,
    response: unknown,
  ): Promise<void> {
    await this.#redis.set(
      key(scope, userId, idempotencyKey),
      JSON.stringify({ payloadHash: hashPayload(payload), response }),
      "EX",
      TTL_SECONDS,
    );
  }

  /** Releases a claim whose request failed, so the client may retry honestly. */
  async release(scope: string, userId: string, idempotencyKey: string): Promise<void> {
    await this.#redis.del(key(scope, userId, idempotencyKey));
  }
}
