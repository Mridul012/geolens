/**
 * Queue policy — concurrency, retries, backoff, priorities and rate limits — in one place
 * rather than scattered across call sites (Engineering-Rules §7, §15.6).
 *
 * Two pools consume these queues (docs/Backend.md §6): browser workers run Chromium and
 * therefore keep concurrency low, while AI workers are I/O bound and are capped by
 * provider rate limits rather than CPU.
 */

export const QUEUE_NAMES = [
  "crawl",
  "index",
  "analyze",
  "aggregate",
  "prompt-sim",
  "report",
  "notify",
  "housekeeping",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Which pool consumes a queue. One image, two entry commands. */
export type WorkerPool = "browser" | "ai";

export interface QueuePolicy {
  readonly pool: WorkerPool;
  /** In-flight jobs per worker process. */
  readonly concurrency: number;
  readonly attempts: number;
  readonly backoff: { readonly type: "exponential" | "fixed"; readonly delay: number };
  /** Seconds a job may run before BullMQ considers the worker stalled. */
  readonly lockDurationSeconds: number;
  /** Optional per-queue throttle: at most `max` jobs started per `durationMs`. */
  readonly limiter?: { readonly max: number; readonly durationMs: number };
  /** Completed/failed retention, so the Redis keyspace cannot grow without bound. */
  readonly keepCompleted: number;
  readonly keepFailed: number;
}

/**
 * Job priority. BullMQ treats *lower* numbers as higher priority: a paying user clicking
 * "Start Crawl" never waits behind a cron batch (docs/Backend.md §5).
 */
export const JOB_PRIORITY = Object.freeze({
  userTriggered: 1,
  scheduled: 5,
  housekeeping: 10,
});

export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = Object.freeze({
  // Chromium is memory-hungry: 2–3 concurrent crawls per instance, long lock because a
  // 100-page crawl legitimately runs for minutes.
  crawl: {
    pool: "browser",
    concurrency: 2,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    lockDurationSeconds: 900,
    keepCompleted: 200,
    keepFailed: 1_000,
  },
  // Reports share the browser pool (one rendering stack for crawling and PDFs) but must
  // not starve an active crawl, hence concurrency 1.
  report: {
    pool: "browser",
    concurrency: 1,
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    lockDurationSeconds: 300,
    keepCompleted: 200,
    keepFailed: 500,
  },
  index: {
    pool: "ai",
    concurrency: 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    lockDurationSeconds: 300,
    limiter: { max: 60, durationMs: 60_000 },
    keepCompleted: 500,
    keepFailed: 1_000,
  },
  analyze: {
    pool: "ai",
    concurrency: 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    lockDurationSeconds: 300,
    limiter: { max: 120, durationMs: 60_000 },
    keepCompleted: 500,
    keepFailed: 1_000,
  },
  // Fan-in parents are cheap but must not be starved by their own children.
  aggregate: {
    pool: "ai",
    concurrency: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    lockDurationSeconds: 600,
    keepCompleted: 200,
    keepFailed: 500,
  },
  // Engine calls are the measurement itself: a tighter limiter protects provider quotas.
  "prompt-sim": {
    pool: "ai",
    concurrency: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 20_000 },
    lockDurationSeconds: 600,
    limiter: { max: 30, durationMs: 60_000 },
    keepCompleted: 200,
    keepFailed: 500,
  },
  notify: {
    pool: "ai",
    concurrency: 5,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    lockDurationSeconds: 120,
    keepCompleted: 200,
    keepFailed: 500,
  },
  // Housekeeping deletes in batches and is deliberately serial: long locks on a user's
  // tables at the moment they are watching is exactly what batching exists to avoid.
  housekeeping: {
    pool: "ai",
    concurrency: 1,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    lockDurationSeconds: 1_800,
    keepCompleted: 100,
    keepFailed: 200,
  },
});

export function queuesForPool(pool: WorkerPool): readonly QueueName[] {
  return QUEUE_NAMES.filter((name) => QUEUE_POLICIES[name].pool === pool);
}

/** Rows deleted per statement by the purge job — small enough never to hold a long lock. */
export const PURGE_BATCH_SIZE = 1_000;

/**
 * Page snapshots per `index` job.
 *
 * Small enough that one poisoned page costs one small retry rather than re-embedding a
 * whole crawl, large enough that a 100-page site fans out to ten jobs rather than a
 * hundred — each of which would carry its own Redis round trip and `job_runs` row.
 */
export const INDEX_BATCH_SIZE = 10;
