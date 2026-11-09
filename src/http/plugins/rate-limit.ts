/**
 * Redis token buckets per user and per IP, with the standard `RateLimit-*` headers on
 * every response (Engineering-Rules §12). Stricter buckets guard sign-in and the three
 * expensive async POSTs.
 *
 * The limiter fails open on a Redis outage: refusing traffic because the limiter is
 * unreachable turns a degradation into an outage (docs/Backend.md §16).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RateLimitDecision, RateLimitRule } from "../../application/ports/rate-limiter.port.js";
import type { RateLimiter } from "../../application/ports/rate-limiter.port.js";
import { rateLimited } from "../../domain/shared/app-error.js";

export type BucketName = "default" | "auth" | "expensive";

export interface RateLimitOptions {
  readonly limiter: RateLimiter;
  readonly rules: Readonly<Record<BucketName, RateLimitRule>>;
}

/** Authenticated callers are limited per account; anonymous ones per IP. */
function subjectOf(request: FastifyRequest): string {
  const userId = request.session?.user.id;
  return userId === undefined ? `ip:${request.ip}` : `user:${userId}`;
}

function applyHeaders(
  reply: { header: (name: string, value: string) => unknown },
  decision: RateLimitDecision,
): void {
  reply.header("ratelimit-limit", String(decision.limit));
  reply.header("ratelimit-remaining", String(decision.remaining));
  reply.header("ratelimit-reset", String(decision.resetSeconds));
}

export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions): void {
  // The default bucket applies to everything; routes opt into a stricter one by setting
  // `config.rateLimitBucket`.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.url === "/health") return;
    const configured = (request.routeOptions.config as { rateLimitBucket?: BucketName } | undefined)
      ?.rateLimitBucket;
    const bucket: BucketName = configured ?? "default";
    const decision = await options.limiter.consume(bucket, subjectOf(request), options.rules[bucket]);
    applyHeaders(reply, decision);
    if (!decision.allowed) {
      throw rateLimited(Math.max(1, decision.resetSeconds));
    }
  });
}
