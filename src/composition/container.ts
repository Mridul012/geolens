// The composition root — the only place allowed to construct infrastructure
// (Engineering-Rules §2.2: no `new PrismaClient()` / `new Queue()` anywhere else).
//
// Edges receive a Container; they never see a Prisma client, a Redis connection or an auth
// SDK, which is what keeps the golden rules true by construction rather than by discipline.
import { createPrismaClient, pingDatabase } from "../infrastructure/db/prisma.js";
import { createRedisClient, pingRedis } from "../infrastructure/redis/redis.js";
import { RedisRateLimiter } from "../infrastructure/redis/rate-limiter.js";
import { BetterAuthGateway } from "../infrastructure/auth/better-auth.gateway.js";
import { UsersRepo } from "../infrastructure/db/repositories/users.repo.js";
import { JobRunsRepo } from "../infrastructure/db/repositories/job-runs.repo.js";
import { CrawlsRepo } from "../infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../infrastructure/db/repositories/events.repo.js";
import { TopicsRepo } from "../infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../infrastructure/db/repositories/topic-coverage.repo.js";
import { ChunksRepo } from "../infrastructure/db/repositories/chunks.repo.js";
import { SiteFactsRepo } from "../infrastructure/db/repositories/site-facts.repo.js";
import { ScoresRepo } from "../infrastructure/db/repositories/scores.repo.js";
import { RecommendationsRepo } from "../infrastructure/db/repositories/recommendations.repo.js";
import { PromptTemplatesRepo } from "../infrastructure/db/repositories/prompt-templates.repo.js";
import { PromptRunsRepo } from "../infrastructure/db/repositories/prompt-runs.repo.js";
import { ReportsRepo } from "../infrastructure/db/repositories/reports.repo.js";
import { SubscriptionsRepo } from "../infrastructure/db/repositories/subscriptions.repo.js";
import { RedisCache } from "../infrastructure/redis/cache.js";
import { RedisProgressStore } from "../infrastructure/redis/progress-store.js";
import { RedisIdempotencyStore } from "../infrastructure/redis/idempotency-store.js";
import { createQueueConnection } from "../infrastructure/queue/connection.js";
import { BullmqJobQueue } from "../infrastructure/queue/bullmq-job-queue.js";
import { createQueueDashboard, type QueueDashboard } from "../infrastructure/queue/bull-board.js";
import { S3ObjectStorage, createS3Client } from "../infrastructure/storage/s3-object-storage.js";
import { ProjectsRepo } from "../infrastructure/db/repositories/projects.repo.js";
import { SitesRepo } from "../infrastructure/db/repositories/sites.repo.js";
import type { AuthGateway } from "../application/ports/auth.port.js";
import type { RateLimiter, RateLimitRule } from "../application/ports/rate-limiter.port.js";
import type { GetCurrentUserDeps } from "../application/auth/get-current-user.js";
import type { ProjectRouteDeps } from "../http/routes/projects.route.js";
import type { CrawlRouteDeps } from "../http/routes/crawls.route.js";
import type { ReadEventsDeps } from "../application/history/read-events.js";
import type { TopicRouteDeps } from "../http/routes/topics.route.js";
import type { DashboardRouteDeps } from "../http/routes/dashboard.route.js";
import type { RecommendationDeps } from "../application/recommendations/read-recommendations.js";
import type { PromptDeps } from "../application/prompt-sim/manage-prompts.js";
import type { PromptRunRouteDeps } from "../http/routes/prompt-runs.route.js";
import type { ReadComparisonDeps } from "../application/analysis/read-comparison.js";
import type { ReportRouteDeps } from "../http/routes/reports.route.js";
import type { BillingRouteDeps } from "../http/routes/billing.route.js";
import type { WebhookRouteDeps } from "../http/routes/webhooks.route.js";
import { createPaymentGateway } from "./payments.js";
import { createIdempotencyGate } from "../http/plugins/idempotency.js";
import { systemClock } from "../application/ports/clock.port.js";
import type { BucketName } from "../http/plugins/rate-limit.js";
import { jobId } from "../contracts/jobs/index.js";
import { JOB_PRIORITY, QUEUE_NAMES } from "../config/queues.js";
import { env } from "../config/env.js";

export interface HealthCheck {
  readonly name: string;
  readonly check: () => Promise<boolean>;
}

export interface Container {
  readonly healthChecks: ReadonlyArray<HealthCheck>;
  readonly auth: AuthGateway;
  readonly rateLimiter: RateLimiter;
  readonly rateLimitRules: Readonly<Record<BucketName, RateLimitRule>>;
  readonly me: GetCurrentUserDeps;
  readonly projects: ProjectRouteDeps;
  readonly crawls: CrawlRouteDeps;
  readonly events: ReadEventsDeps;
  readonly topics: TopicRouteDeps;
  readonly analytics: DashboardRouteDeps;
  readonly recommendations: RecommendationDeps;
  readonly prompts: PromptDeps;
  readonly promptRuns: PromptRunRouteDeps;
  readonly comparison: ReadComparisonDeps;
  readonly reports: ReportRouteDeps;
  readonly billing: BillingRouteDeps;
  readonly webhooks: WebhookRouteDeps;
  readonly allowedOrigins: readonly string[];
  /** The queue dashboard, ready to mount behind admin auth. */
  readonly queueDashboard: QueueDashboard;
  readonly shutdown: () => Promise<void>;
}

/** Buckets are per minute; policy lives in config, never at a call site (§15.6). */
function rateLimitRules(): Readonly<Record<BucketName, RateLimitRule>> {
  return Object.freeze({
    default: { capacity: env.RATE_LIMIT_DEFAULT_PER_MINUTE, windowSeconds: 60 },
    auth: { capacity: env.RATE_LIMIT_AUTH_PER_MINUTE, windowSeconds: 60 },
    expensive: { capacity: env.RATE_LIMIT_EXPENSIVE_PER_MINUTE, windowSeconds: 60 },
  });
}

export function createContainer(): Container {
  const prisma = createPrismaClient();
  const redis = createRedisClient();

  const users = new UsersRepo(prisma);
  const projects = new ProjectsRepo(prisma);
  const sites = new SitesRepo(prisma);
  const jobRuns = new JobRunsRepo(prisma);
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
  const paymentGateway = createPaymentGateway();
  const storage = new S3ObjectStorage(createS3Client());
  const cache = new RedisCache(redis);
  const progress = new RedisProgressStore(redis);
  const idempotency = createIdempotencyGate(new RedisIdempotencyStore(redis));

  // The API enqueues; it never consumes. Workers own the consuming side.
  const queueConnection = createQueueConnection();
  const jobQueue = new BullmqJobQueue(queueConnection, jobRuns);

  return {
    healthChecks: [
      { name: "postgres", check: () => pingDatabase(prisma) },
      { name: "redis", check: () => pingRedis(redis) },
    ],
    auth: new BetterAuthGateway(prisma),
    rateLimiter: new RedisRateLimiter(redis),
    rateLimitRules: rateLimitRules(),
    me: { users, clock: systemClock },
    // The purge job is wired in M5; until then a deleted project is soft-deleted and
    // invisible, and housekeeping collects it.
    projects: {
      projects,
      sites,
      users,
      clock: systemClock,
      schedulePurge: async (projectId: string) => {
        await jobQueue.enqueue(
          "housekeeping",
          { task: "purge-project", payload: { projectId } },
          { jobId: jobId.purgeProject(projectId), priority: JOB_PRIORITY.housekeeping },
        );
      },
    },
    // The web app's origin is always trusted; CORS_ORIGINS adds any others.
    allowedOrigins: [env.APP_BASE_URL, ...env.CORS_ORIGINS],
    crawls: {
      projects,
      sites,
      crawls,
      users,
      queue: jobQueue,
      progress,
      clock: systemClock,
      idempotency,
      baseUrl: env.API_BASE_URL,
    },
    events: { projects, events },
    topics: {
      topics: { projects, topics },
      coverage: { projects, sites, crawls, topics, coverage: topicCoverage },
    },
    analytics: {
      dashboard: {
        projects,
        cache,
        clock: systemClock,
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
      clock: systemClock,
      idempotency,
      baseUrl: env.API_BASE_URL,
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
      clock: systemClock,
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
      idempotency,
      baseUrl: env.API_BASE_URL,
    },
    billing: {
      checkout: { users, subscriptions, gateway: paymentGateway, baseUrl: env.APP_BASE_URL },
      portal: { subscriptions, gateway: paymentGateway, baseUrl: env.APP_BASE_URL },
    },
    webhooks: { subscriptions, gateway: paymentGateway },
    queueDashboard: createQueueDashboard(
      QUEUE_NAMES.map((name) => jobQueue.queueFor(name)),
      "/admin/queues",
    ),
    shutdown: async () => {
      await jobQueue.close();
      await prisma.$disconnect();
      redis.disconnect();
      queueConnection.disconnect();
    },
  };
}
