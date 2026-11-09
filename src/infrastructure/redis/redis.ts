// Redis connection factory. Construction happens in composition/ (Engineering-Rules §2.2).
// BullMQ, the rate limiter, the progress store and the dashboard cache all share this
// server but hold their own connections — BullMQ's blocking reads must never sit behind
// another subsystem's command.
import { Redis, type RedisOptions } from "ioredis";
import { env } from "../../config/env.js";

export type RedisClient = Redis;

export interface RedisConnectionOptions {
  /** BullMQ requires `maxRetriesPerRequest: null` on its own connections. */
  readonly forQueue?: boolean;
}

export function createRedisClient(options: RedisConnectionOptions = {}): Redis {
  const base: RedisOptions = {
    lazyConnect: false,
    enableReadyCheck: true,
    // Reads pause rather than fail when Redis is unavailable — the API keeps serving
    // Postgres-backed reads while job intake stalls (docs/Backend.md §16).
    maxRetriesPerRequest: options.forQueue === true ? null : 3,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  };
  return new Redis(env.REDIS_URL, base);
}

export async function pingRedis(client: Redis): Promise<boolean> {
  return (await client.ping()) === "PONG";
}
