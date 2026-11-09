/**
 * Builds the real application for e2e tests — same factory the process uses, live wiring,
 * real Postgres and Redis (Engineering-Rules §9). Only the pieces a test wants to control
 * are substituted.
 */
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppDependencies } from "../../src/http/app.js";
import { BetterAuthGateway } from "../../src/infrastructure/auth/better-auth.gateway.js";
import { UsersRepo } from "../../src/infrastructure/db/repositories/users.repo.js";
import { ProjectsRepo } from "../../src/infrastructure/db/repositories/projects.repo.js";
import { SitesRepo } from "../../src/infrastructure/db/repositories/sites.repo.js";
import { CrawlsRepo } from "../../src/infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../../src/infrastructure/db/repositories/events.repo.js";
import { TopicsRepo } from "../../src/infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../../src/infrastructure/db/repositories/topic-coverage.repo.js";
import { ChunksRepo } from "../../src/infrastructure/db/repositories/chunks.repo.js";
import { SiteFactsRepo } from "../../src/infrastructure/db/repositories/site-facts.repo.js";
import { ScoresRepo } from "../../src/infrastructure/db/repositories/scores.repo.js";
import { RecommendationsRepo } from "../../src/infrastructure/db/repositories/recommendations.repo.js";
import { PromptTemplatesRepo } from "../../src/infrastructure/db/repositories/prompt-templates.repo.js";
import { PromptRunsRepo } from "../../src/infrastructure/db/repositories/prompt-runs.repo.js";
import { ReportsRepo } from "../../src/infrastructure/db/repositories/reports.repo.js";
import { SubscriptionsRepo } from "../../src/infrastructure/db/repositories/subscriptions.repo.js";
import { FakePaymentGateway } from "../../src/infrastructure/payments/fake-gateway.js";
import {
  S3ObjectStorage,
  createS3Client,
} from "../../src/infrastructure/storage/s3-object-storage.js";
import { RedisCache } from "../../src/infrastructure/redis/cache.js";
import { JobRunsRepo } from "../../src/infrastructure/db/repositories/job-runs.repo.js";
import { RedisProgressStore } from "../../src/infrastructure/redis/progress-store.js";
import { RedisIdempotencyStore } from "../../src/infrastructure/redis/idempotency-store.js";
import { BullmqJobQueue } from "../../src/infrastructure/queue/bullmq-job-queue.js";
import { createQueueConnection } from "../../src/infrastructure/queue/connection.js";
import { createIdempotencyGate } from "../../src/http/plugins/idempotency.js";
import { RedisRateLimiter } from "../../src/infrastructure/redis/rate-limiter.js";
import { createRedisClient } from "../../src/infrastructure/redis/redis.js";
import type { RateLimiter } from "../../src/application/ports/rate-limiter.port.js";
import type { Clock } from "../../src/application/ports/clock.port.js";
import { createTestPrisma } from "./db.js";

/** Never limits — the default for tests that are not about rate limiting. */
export const permissiveRateLimiter: RateLimiter = {
  consume: async (_bucket, _subject, rule) => ({
    allowed: true,
    limit: rule.capacity,
    remaining: rule.capacity,
    resetSeconds: 0,
  }),
};

export function fixedClock(at: Date): Clock {
  return { now: () => at };
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly prisma: PrismaClient;
  /** Jobs the app enqueued, so a route test can assert intent without a worker. */
  readonly enqueued: () => ReadonlyArray<{ queue: string; payload: unknown; jobId: string }>;
  readonly close: () => Promise<void>;
}

export interface TestAppOptions {
  readonly rateLimiter?: RateLimiter;
  /** Use the real BullMQ queue instead of the recording fake (worker round-trips). */
  readonly useRealQueue?: boolean;
  readonly clock?: Clock;
  readonly allowedOrigins?: readonly string[];
  readonly useRealRedisRateLimiter?: boolean;
}

export async function buildTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const prisma = createTestPrisma();
  // Progress and idempotency are Redis-backed everywhere, including in tests: they are
  // where the async contract actually lives.
  const redis = createRedisClient();
  const queueConnection = options.useRealQueue === true ? createQueueConnection() : null;

  const enqueued: Array<{ queue: string; payload: unknown; jobId: string }> = [];
  const jobQueue =
    queueConnection === null
      ? {
          enqueue: async (queue: string, payload: unknown, opts: { jobId: string }) => {
            enqueued.push({ queue, payload, jobId: opts.jobId });
          },
        }
      : new BullmqJobQueue(queueConnection, new JobRunsRepo(prisma));

  const users = new UsersRepo(prisma);
  const projects = new ProjectsRepo(prisma);
  const sites = new SitesRepo(prisma);
  const crawls = new CrawlsRepo(prisma);
  const events = new EventsRepo(prisma);
  const topics = new TopicsRepo(prisma);
  const topicCoverage = new TopicCoverageRepo(prisma);
  const chunks = new ChunksRepo(prisma);
  const siteFacts = new SiteFactsRepo(prisma);
  const scores = new ScoresRepo(prisma);
  const recommendations = new RecommendationsRepo(prisma);
  const promptTemplates = new PromptTemplatesRepo(prisma);
  const promptRuns = new PromptRunsRepo(prisma);
  const reports = new ReportsRepo(prisma);
  const subscriptions = new SubscriptionsRepo(prisma);
  const paymentGateway = new FakePaymentGateway();
  const storage = new S3ObjectStorage(createS3Client());
  const progress = new RedisProgressStore(redis);
  const clock: Clock = options.clock ?? { now: () => new Date() };

  const deps: AppDependencies = {
    logger: pino({ level: "silent" }),
    auth: new BetterAuthGateway(prisma),
    rateLimiter:
      options.useRealRedisRateLimiter === true
        ? new RedisRateLimiter(redis)
        : (options.rateLimiter ?? permissiveRateLimiter),
    rateLimitRules: {
      default: { capacity: 120, windowSeconds: 60 },
      auth: { capacity: 10, windowSeconds: 60 },
      expensive: { capacity: 5, windowSeconds: 60 },
    },
    me: { users, clock },
    projects: { projects, sites, users, clock },
    crawls: {
      projects,
      sites,
      crawls,
      users,
      queue: jobQueue,
      progress,
      clock,
      idempotency: createIdempotencyGate(new RedisIdempotencyStore(redis)),
      baseUrl: "http://localhost:3000",
    },
    events: { projects, events },
    topics: {
      topics: { projects, topics },
      coverage: { projects, sites, crawls, topics, coverage: topicCoverage },
    },
    analytics: {
      dashboard: {
        projects,
        cache: new RedisCache(redis),
        clock,
        crawls,
        scores,
        sites,
        topics,
        coverage: topicCoverage,
        chunks,
        recommendations,
        runs: promptRuns,
      },
      scores: { projects, scores },
    },
    recommendations: { projects, recommendations },
    prompts: { projects, users, prompts: promptTemplates },
    promptRuns: {
      projects,
      users,
      runs: promptRuns,
      prompts: promptTemplates,
      queue: jobQueue,
      progress,
      clock,
      idempotency: createIdempotencyGate(new RedisIdempotencyStore(redis)),
      baseUrl: "http://localhost:3000",
    },
    comparison: {
      projects,
      sites,
      crawls,
      scores,
      siteFacts,
      chunks,
      topics,
      coverage: topicCoverage,
      runs: promptRuns,
      users,
      clock,
    },
    reports: {
      projects,
      sites,
      crawls,
      runs: promptRuns,
      reports,
      users,
      storage,
      queue: jobQueue,
      idempotency: createIdempotencyGate(new RedisIdempotencyStore(redis)),
      baseUrl: "http://localhost:3000",
    },
    billing: {
      checkout: { users, subscriptions, gateway: paymentGateway, baseUrl: "http://localhost:3001" },
      portal: { subscriptions, gateway: paymentGateway, baseUrl: "http://localhost:3001" },
    },
    webhooks: { subscriptions, gateway: paymentGateway },
    baseUrl: "http://localhost:3000",
    allowedOrigins: options.allowedOrigins ?? ["http://localhost:3001"],
  };

  const app = await buildApp(deps);

  return {
    app,
    prisma,
    enqueued: () => enqueued,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
      redis.disconnect();
      queueConnection?.disconnect();
    },
  };
}

/** Extracts the session cookie pair from a Set-Cookie header list. */
export function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return cookies.map((cookie) => String(cookie).split(";", 1)[0]).join("; ");
}
