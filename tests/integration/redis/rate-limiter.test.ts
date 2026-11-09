/**
 * The limiter is a Lua script, so it gets tested against a real Redis — never a mock of
 * the thing under test (Engineering-Rules §9).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisClient } from "../../../src/infrastructure/redis/redis.js";
import { RedisRateLimiter } from "../../../src/infrastructure/redis/rate-limiter.js";
import type { RedisClient } from "../../../src/infrastructure/redis/redis.js";

let redis: RedisClient;
let limiter: RedisRateLimiter;

const subject = () => `test-${Date.now()}-${Math.random()}`;

beforeAll(() => {
  redis = createRedisClient();
  limiter = new RedisRateLimiter(redis);
});

afterAll(() => {
  redis.disconnect();
});

describe("RedisRateLimiter", () => {
  it("allows a burst up to capacity, then refuses", async () => {
    const who = subject();
    const rule = { capacity: 3, windowSeconds: 60 };

    const first = await limiter.consume("test", who, rule);
    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2 });

    await limiter.consume("test", who, rule);
    const third = await limiter.consume("test", who, rule);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await limiter.consume("test", who, rule);
    expect(fourth.allowed).toBe(false);
    expect(fourth.resetSeconds).toBeGreaterThan(0);
  });

  it("keeps buckets independent per subject", async () => {
    const rule = { capacity: 1, windowSeconds: 60 };
    const a = subject();
    const b = subject();

    expect((await limiter.consume("test", a, rule)).allowed).toBe(true);
    expect((await limiter.consume("test", a, rule)).allowed).toBe(false);
    expect((await limiter.consume("test", b, rule)).allowed).toBe(true);
  });

  it("keeps buckets independent per bucket name", async () => {
    const rule = { capacity: 1, windowSeconds: 60 };
    const who = subject();
    expect((await limiter.consume("auth", who, rule)).allowed).toBe(true);
    expect((await limiter.consume("auth", who, rule)).allowed).toBe(false);
    expect((await limiter.consume("expensive", who, rule)).allowed).toBe(true);
  });

  it("refills continuously rather than resetting on a window boundary", async () => {
    const who = subject();
    // 10 tokens per second: one becomes available roughly every 100ms.
    const rule = { capacity: 2, windowSeconds: 0.2 };

    expect((await limiter.consume("test", who, rule)).allowed).toBe(true);
    expect((await limiter.consume("test", who, rule)).allowed).toBe(true);
    expect((await limiter.consume("test", who, rule)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await limiter.consume("test", who, rule)).allowed).toBe(true);
  });

  it("fails open when Redis is unreachable — a limiter outage is not a service outage", async () => {
    const broken = createRedisClient();
    broken.disconnect();
    const brokenLimiter = new RedisRateLimiter(broken);

    const decision = await brokenLimiter.consume("test", subject(), {
      capacity: 1,
      windowSeconds: 60,
    });
    expect(decision.allowed).toBe(true);
  });
});
