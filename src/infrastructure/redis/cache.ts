/**
 * The Cache port over Redis.
 *
 * Values are JSON. A malformed or unreadable entry is treated as a miss rather than an
 * error: the payload is derived data, and a stale-format cache from an older deploy should
 * cost one rebuild, not a 500.
 */
import type { Redis } from "ioredis";
import type { Cache } from "../../application/ports/cache.port.js";

export class RedisCache implements Cache {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.#redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Written by an older shape. Drop it and let the caller rebuild.
      await this.#redis.del(key);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.#redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(key);
  }
}
