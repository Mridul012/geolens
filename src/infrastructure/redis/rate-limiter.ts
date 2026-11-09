/**
 * Redis token-bucket rate limiter (Engineering-Rules §12).
 *
 * A bucket refills continuously rather than resetting on a fixed window, so a client that
 * paces itself is never punished for the boundary. The whole decision happens inside one
 * Lua script: read, refill, consume and expire are atomic, which is what makes the limit
 * hold across several API instances.
 */
import type { Redis } from "ioredis";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the bucket has at least one token again. */
  readonly resetSeconds: number;
}

export interface RateLimitRule {
  /** Bucket capacity — the most a client may spend in a burst. */
  readonly capacity: number;
  /** Sustained rate; capacity is refilled over this window. */
  readonly windowSeconds: number;
}

const CONSUME_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_second = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'updated_ms')
local tokens = tonumber(bucket[1])
local updated_ms = tonumber(bucket[2])

if tokens == nil or updated_ms == nil then
  tokens = capacity
  updated_ms = now_ms
end

local elapsed_seconds = math.max(0, (now_ms - updated_ms) / 1000)
tokens = math.min(capacity, tokens + elapsed_seconds * refill_per_second)

local allowed = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
end

redis.call('HSET', key, 'tokens', tokens, 'updated_ms', now_ms)
redis.call('EXPIRE', key, ttl_seconds)

local reset_seconds = 0
if tokens < 1 then
  reset_seconds = math.ceil((1 - tokens) / refill_per_second)
end

return { allowed, math.floor(tokens), reset_seconds }
`;

export class RedisRateLimiter {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /**
   * Spends one token from `subject`'s bucket.
   *
   * A Redis outage fails **open**: rate limiting protects capacity, and refusing every
   * request because the limiter is unreachable would turn a degradation into an outage
   * (docs/Backend.md §16). The caller logs it; the request proceeds.
   */
  async consume(
    bucket: string,
    subject: string,
    rule: RateLimitRule,
  ): Promise<RateLimitDecision> {
    const key = `rl:${bucket}:${subject}`;
    const refillPerSecond = rule.capacity / rule.windowSeconds;
    const ttlSeconds = Math.ceil(rule.windowSeconds * 2);

    try {
      const raw = (await this.#redis.eval(
        CONSUME_SCRIPT,
        1,
        key,
        String(rule.capacity),
        String(refillPerSecond),
        String(Date.now()),
        String(ttlSeconds),
      )) as [number, number, number];

      return {
        allowed: raw[0] === 1,
        limit: rule.capacity,
        remaining: Math.max(0, raw[1]),
        resetSeconds: raw[2],
      };
    } catch {
      return { allowed: true, limit: rule.capacity, remaining: rule.capacity, resetSeconds: 0 };
    }
  }
}
