/**
 * ProgressStore over a Redis hash (docs/Backend.md §4.1).
 *
 * One hash per crawl, written by the worker and read by the SSE endpoint every ~1.5s.
 * Deliberately not pub/sub: a hash is resume-safe by construction — a client that
 * reconnects reads current state rather than missing the events it was away for.
 *
 * Everything here expires. If Redis is flushed the UI loses its progress bar and falls
 * back to the crawl row in Postgres; no domain data is at risk (§7).
 */
import type { Redis } from "ioredis";
import type {
  CrawlProgress,
  CrawlStage,
  FrontierCheckpoint,
  ProgressStore,
  PromptRunProgress,
} from "../../application/ports/progress-store.port.js";

/** Long enough to outlive the slowest crawl, short enough that abandoned keys vanish. */
const PROGRESS_TTL_SECONDS = 24 * 60 * 60;
const CANCEL_TTL_SECONDS = 6 * 60 * 60;

const crawlKey = (crawlId: string): string => `progress:crawl:${crawlId}`;
const runKey = (runId: string): string => `progress:run:${runId}`;
const cancelKey = (crawlId: string): string => `cancel:crawl:${crawlId}`;
const frontierKey = (crawlId: string): string => `frontier:crawl:${crawlId}`;

/** A frontier is only useful to the retry that follows within minutes. */
const FRONTIER_TTL_SECONDS = 6 * 60 * 60;
/** Bounded so a pathological site cannot write an unbounded value into Redis. */
const FRONTIER_MAX_URLS = 5_000;

function toStringRecord(progress: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(progress)) {
    if (value === undefined) continue;
    fields[key] = value === null ? "" : String(value);
  }
  return fields;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class RedisProgressStore implements ProgressStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async saveFrontier(crawlId: string, urls: readonly string[]): Promise<void> {
    if (urls.length === 0) {
      await this.clearFrontier(crawlId);
      return;
    }
    await this.#redis.set(
      frontierKey(crawlId),
      JSON.stringify({ urls: urls.slice(0, FRONTIER_MAX_URLS), savedAt: new Date().toISOString() }),
      "EX",
      FRONTIER_TTL_SECONDS,
    );
  }

  async loadFrontier(crawlId: string): Promise<FrontierCheckpoint | null> {
    const raw = await this.#redis.get(frontierKey(crawlId));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as FrontierCheckpoint;
      return Array.isArray(parsed.urls) ? parsed : null;
    } catch {
      // A corrupt checkpoint is worth nothing and must not fail the resume.
      return null;
    }
  }

  async clearFrontier(crawlId: string): Promise<void> {
    await this.#redis.del(frontierKey(crawlId));
  }

  async setCrawlProgress(crawlId: string, progress: Partial<CrawlProgress>): Promise<void> {
    const key = crawlKey(crawlId);
    const fields = toStringRecord({ ...progress, updatedAt: new Date().toISOString() });
    if (Object.keys(fields).length === 0) return;
    // Partial writes merge into the hash, so a stage update need not restate the counters.
    await this.#redis.hset(key, fields);
    await this.#redis.expire(key, PROGRESS_TTL_SECONDS);
  }

  async getCrawlProgress(crawlId: string): Promise<CrawlProgress | null> {
    const raw = await this.#redis.hgetall(crawlKey(crawlId));
    if (Object.keys(raw).length === 0) return null;

    return {
      stage: (raw["stage"] ?? "queued") as CrawlStage,
      message: raw["message"] ?? "",
      pagesFound: parseNumber(raw["pagesFound"], 0),
      pagesCrawled: parseNumber(raw["pagesCrawled"], 0),
      currentUrl: raw["currentUrl"] === undefined || raw["currentUrl"] === "" ? null : raw["currentUrl"],
      etaSeconds:
        raw["etaSeconds"] === undefined || raw["etaSeconds"] === ""
          ? null
          : parseNumber(raw["etaSeconds"], 0),
      status: raw["status"] === undefined || raw["status"] === "" ? null : raw["status"],
      updatedAt: raw["updatedAt"] ?? new Date().toISOString(),
    };
  }

  async setPromptRunProgress(runId: string, progress: Partial<PromptRunProgress>): Promise<void> {
    const key = runKey(runId);
    const fields = toStringRecord({ ...progress, updatedAt: new Date().toISOString() });
    if (Object.keys(fields).length === 0) return;
    await this.#redis.hset(key, fields);
    await this.#redis.expire(key, PROGRESS_TTL_SECONDS);
  }

  async getPromptRunProgress(runId: string): Promise<PromptRunProgress | null> {
    const raw = await this.#redis.hgetall(runKey(runId));
    if (Object.keys(raw).length === 0) return null;
    return {
      cellsDone: parseNumber(raw["cellsDone"], 0),
      cellsTotal: parseNumber(raw["cellsTotal"], 0),
      status: raw["status"] === undefined || raw["status"] === "" ? null : raw["status"],
      updatedAt: raw["updatedAt"] ?? new Date().toISOString(),
    };
  }

  async requestCancel(crawlId: string): Promise<void> {
    await this.#redis.set(cancelKey(crawlId), "1", "EX", CANCEL_TTL_SECONDS);
  }

  async isCancelRequested(crawlId: string): Promise<boolean> {
    return (await this.#redis.exists(cancelKey(crawlId))) === 1;
  }

  async clear(crawlId: string): Promise<void> {
    await this.#redis.del(crawlKey(crawlId), cancelKey(crawlId), frontierKey(crawlId));
  }
}
