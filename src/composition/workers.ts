/**
 * Worker composition root: the only place a Worker, a Queue or a repository is constructed
 * for the two worker processes (Engineering-Rules §2.2).
 */
import { createPrismaClient, pingDatabase } from "../infrastructure/db/prisma.js";
import { pingRedis } from "../infrastructure/redis/redis.js";
import { createQueueConnection } from "../infrastructure/queue/connection.js";
import { BullmqJobQueue } from "../infrastructure/queue/bullmq-job-queue.js";
import { BullmqJobFlow } from "../infrastructure/queue/bullmq-job-flow.js";
import {
  startWorkerRuntime,
  type ProcessorMap,
  type WorkerRuntime,
} from "../infrastructure/queue/worker-runtime.js";
import { JobRunsRepo } from "../infrastructure/db/repositories/job-runs.repo.js";
import { PurgeRepo } from "../infrastructure/db/repositories/purge.repo.js";
import { CrawlsRepo } from "../infrastructure/db/repositories/crawls.repo.js";
import { EventsRepo } from "../infrastructure/db/repositories/events.repo.js";
import { ProjectsRepo } from "../infrastructure/db/repositories/projects.repo.js";
import { SitesRepo } from "../infrastructure/db/repositories/sites.repo.js";
import { UsersRepo } from "../infrastructure/db/repositories/users.repo.js";
import { RedisProgressStore } from "../infrastructure/redis/progress-store.js";
import { createRedisClient } from "../infrastructure/redis/redis.js";
import { S3ObjectStorage, createS3Client } from "../infrastructure/storage/s3-object-storage.js";
import { SiteCrawler } from "../infrastructure/crawler/site-crawler.js";
import { PlaywrightPageFetcher } from "../infrastructure/crawler/playwright-page-fetcher.js";
import { PlaywrightPdfRenderer } from "../infrastructure/rendering/playwright-pdf-renderer.js";
import { extractPage } from "../infrastructure/crawler/extractors/html.js";
import { HttpAccessProber } from "../infrastructure/crawler/access-prober.adapter.js";
import { TopicsRepo } from "../infrastructure/db/repositories/topics.repo.js";
import { TopicCoverageRepo } from "../infrastructure/db/repositories/topic-coverage.repo.js";
import { ChunksRepo } from "../infrastructure/db/repositories/chunks.repo.js";
import { ScoresRepo } from "../infrastructure/db/repositories/scores.repo.js";
import { SiteFactsRepo } from "../infrastructure/db/repositories/site-facts.repo.js";
import { RecommendationsRepo } from "../infrastructure/db/repositories/recommendations.repo.js";
import { PromptTemplatesRepo } from "../infrastructure/db/repositories/prompt-templates.repo.js";
import { PromptRunsRepo } from "../infrastructure/db/repositories/prompt-runs.repo.js";
import { ReportsRepo } from "../infrastructure/db/repositories/reports.repo.js";
import { TldtsPublicSuffix } from "../infrastructure/net/public-suffix.js";
import { RedisCache } from "../infrastructure/redis/cache.js";
import { AiUsageRepo } from "../infrastructure/db/repositories/ai-usage.repo.js";
import { loadPrompt, render } from "../infrastructure/ai/prompts/registry.js";
import { createAiComposition } from "./ai.js";
import { createMailer } from "./email.js";
import { registerSchedules } from "../infrastructure/queue/schedules.js";
import { createHousekeepingProcessor } from "../workers/processors/housekeeping.js";
import { createCrawlProcessor } from "../workers/processors/crawl.js";
import { createIndexProcessor } from "../workers/processors/index.js";
import { createAnalyzeProcessor } from "../workers/processors/analyze.js";
import { createAggregateProcessor } from "../workers/processors/aggregate.js";
import { createPromptSimProcessor } from "../workers/processors/prompt-sim.js";
import { createReportProcessor } from "../workers/processors/report.js";
import { createNotifyProcessor } from "../workers/processors/notify.js";
import { systemClock } from "../application/ports/clock.port.js";
import { env } from "../config/env.js";
import type { WorkerPool } from "../config/queues.js";
import type { Logger } from "../infrastructure/telemetry/logger.js";
import type { HealthCheck } from "./container.js";

export interface WorkerContainer {
  readonly runtime: WorkerRuntime;
  readonly healthChecks: ReadonlyArray<HealthCheck>;
  readonly shutdown: () => Promise<void>;
}

export function createWorkerContainer(pool: WorkerPool, logger: Logger): WorkerContainer {
  const prisma = createPrismaClient();
  const connection = createQueueConnection();
  const redis = createRedisClient();

  const jobRuns = new JobRunsRepo(prisma);
  const purgeRepo = new PurgeRepo(prisma);
  const crawls = new CrawlsRepo(prisma);
  const events = new EventsRepo(prisma);
  const projects = new ProjectsRepo(prisma);
  const sites = new SitesRepo(prisma);
  const users = new UsersRepo(prisma);
  const progress = new RedisProgressStore(redis);
  const storage = new S3ObjectStorage(createS3Client());
  const topics = new TopicsRepo(prisma);
  const topicCoverage = new TopicCoverageRepo(prisma);
  const chunks = new ChunksRepo(prisma);
  const scores = new ScoresRepo(prisma);
  const siteFacts = new SiteFactsRepo(prisma);
  const recommendations = new RecommendationsRepo(prisma);
  const promptTemplates = new PromptTemplatesRepo(prisma);
  const promptRuns = new PromptRunsRepo(prisma);
  const reports = new ReportsRepo(prisma);
  const publicSuffix = new TldtsPublicSuffix();
  const cache = new RedisCache(redis);
  const aiUsage = new AiUsageRepo(prisma);
  const ai = createAiComposition(aiUsage, logger);
  const mailer = createMailer();
  const queue = new BullmqJobQueue(connection, jobRuns);
  const flow = new BullmqJobFlow(connection, jobRuns);

  // Chromium is launched lazily by the fetcher, so the AI pool never pays for it.
  const fetcher = new PlaywrightPageFetcher({
    userAgent: env.CRAWLER_USER_AGENT,
    timeoutMs: env.CRAWLER_PAGE_TIMEOUT_MS,
  });
  const engine = new SiteCrawler({
    fetcher,
    userAgent: env.CRAWLER_USER_AGENT,
    timeoutMs: env.CRAWLER_PAGE_TIMEOUT_MS,
    delayMs: env.CRAWLER_DELAY_MS,
    timeBudgetMs: env.CRAWLER_TIME_BUDGET_MS,
  });
  // Its own lazily-launched Chromium, separate from the crawler's fetcher — the `report`
  // queue shares the browser worker *pool* (docs/Backend.md §6), not a single browser.
  const pdfRenderer = new PlaywrightPdfRenderer();

  const processors: ProcessorMap = {
    crawl: createCrawlProcessor({
      pipeline: {
        crawls,
        sites,
        projects,
        users,
        events,
        engine,
        storage,
        progress,
        extract: extractPage,
      },
      // Cheap HTTP work, so it uses the guarded fetcher rather than the browser pool.
      accessCheck: {
        crawls,
        sites,
        events,
        prober: new HttpAccessProber({
          userAgent: env.CRAWLER_USER_AGENT,
          timeoutMs: env.CRAWLER_PAGE_TIMEOUT_MS,
        }),
        clock: systemClock,
      },
      taxonomy: {
        gateway: ai.gateway,
        crawls,
        sites,
        topics,
        prompt: loadPrompt,
        render,
      },
      // Generated once per project: regenerating on every crawl would spend a frontier
      // call to reproduce a taxonomy the user may have since edited.
      needsTaxonomy: async (projectId: string) => (await topics.countActive(projectId)) === 0,
      trackedPrompts: {
        gateway: ai.gateway,
        crawls,
        sites,
        topics,
        prompts: promptTemplates,
        prompt: loadPrompt,
        render,
      },
      needsPrompts: async (projectId: string) =>
        (await promptTemplates.countGenerated(projectId)) === 0,
      // The crawl no longer finalizes itself: it hands off to the analysis flow, whose
      // aggregate parent gives the crawl its terminal state (docs/Backend.md §4.1).
      analysis: { crawls, flow },
    }),
    index: createIndexProcessor({ gateway: ai.gateway, chunks, crawls }),
    analyze: createAnalyzeProcessor({
      coverage: { chunks, crawls, topics, coverage: topicCoverage },
      retrievability: {
        gateway: ai.gateway,
        chunks,
        crawls,
        sites,
        topics,
        prompt: loadPrompt,
        render,
      },
      pageQuality: { gateway: ai.gateway, crawls, prompt: loadPrompt, render },
    }),
    aggregate: createAggregateProcessor({
      crawls,
      chunks,
      events,
      progress,
      scoring: { crawls, scores, siteFacts, topics, coverage: topicCoverage },
      recommendations: {
        gateway: ai.gateway,
        crawls,
        sites,
        topics,
        coverage: topicCoverage,
        siteFacts,
        recommendations,
        clock: systemClock,
        prompt: loadPrompt,
        render,
      },
      summary: {
        gateway: ai.gateway,
        crawls,
        sites,
        topics,
        coverage: topicCoverage,
        prompt: loadPrompt,
        render,
      },
      dashboard: {
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
      notify: { queue },
    }),
    "prompt-sim": createPromptSimProcessor({
      simulation: {
        gateway: ai.gateway,
        runs: promptRuns,
        prompts: promptTemplates,
        projects,
        sites,
        events,
        progress,
        publicSuffix,
        prompt: loadPrompt,
        render,
      },
      scoring: { runs: promptRuns, scores, events },
      dashboard: {
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
    }),
    report: createReportProcessor({
      reports,
      assemble: {
        projects,
        sites,
        crawls,
        scores,
        siteFacts,
        chunks,
        topics,
        coverage: topicCoverage,
        recommendations,
        clock: systemClock,
      },
      renderer: pdfRenderer,
      storage,
      clock: systemClock,
    }),
    notify: createNotifyProcessor({
      crawlComplete: { projects, users, scores, mailer, baseUrl: env.APP_BASE_URL },
      digest: {
        projects,
        users,
        scores,
        events,
        recommendations,
        mailer,
        clock: systemClock,
        baseUrl: env.APP_BASE_URL,
      },
    }),
    housekeeping: createHousekeepingProcessor({
      purge: { purge: purgeRepo, storage },
      sweep: { purge: purgeRepo, queue, clock: systemClock },
      scheduleWeeklyCrawls: { projects, sites, crawls, users, queue, progress, clock: systemClock },
      scheduleWeeklyPromptRuns: {
        projects,
        users,
        runs: promptRuns,
        prompts: promptTemplates,
        queue,
        progress,
        clock: systemClock,
      },
      scheduleWeeklyDigests: { projects, queue, clock: systemClock },
      usageRollup: { crawls, aiUsage },
      sweepFailedJobs: {
        jobRuns,
        mailer,
        clock: systemClock,
        opsAlertEmail: env.OPS_ALERT_EMAIL ?? null,
      },
      budgetMonitor: {
        projects,
        aiUsage,
        mailer,
        clock: systemClock,
        budgetMicros: env.AI_BUDGET_PER_PROJECT_MONTHLY_MICROS,
        opsAlertEmail: env.OPS_ALERT_EMAIL ?? null,
      },
    }),
  };

  // Idempotent across restarts (M18): registers or updates every scheduler, never
  // duplicates one. Fired once from the pool that actually consumes `housekeeping`, and
  // not awaited — the next tick is at minimum an hour away, so this must never delay the
  // worker's own readiness.
  if (pool === "ai") {
    void registerSchedules(queue).catch((error: unknown) => {
      logger.error({ err: error }, "failed to register job schedulers");
    });
  }

  const runtime = startWorkerRuntime({ pool, connection, jobRuns, logger, processors });

  return {
    runtime,
    healthChecks: [
      { name: "postgres", check: () => pingDatabase(prisma) },
      { name: "redis", check: () => pingRedis(connection) },
    ],
    shutdown: async () => {
      await runtime.drain();
      await ai.tracer.flush();
      await fetcher.close();
      await pdfRenderer.close();
      await flow.close();
      await queue.close();
      await prisma.$disconnect();
      connection.disconnect();
      redis.disconnect();
    },
  };
}
