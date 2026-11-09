/** Rate limiting behind a port so the edge never imports a Redis client. */

export interface RateLimitRule {
  /** Bucket capacity — the most a caller may spend in a burst. */
  readonly capacity: number;
  /** Sustained rate; capacity refills over this window. */
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
}

export interface RateLimiter {
  consume(bucket: string, subject: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}
