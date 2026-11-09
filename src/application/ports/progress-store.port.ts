/**
 * Live job progress behind a port (Engineering-Rules §7: progress goes through the
 * ProgressStore feeding SSE — never invent a second progress channel).
 *
 * Progress is operational state, not domain data: it lives in Redis, it expires, and
 * losing it costs a spinner, never a result. The authoritative record of what happened is
 * always Postgres.
 */

/** Friendly stage messages the UI narrates (docs/API.md §1 — SSE `stage` events). */
export type CrawlStage =
  | "queued"
  | "discovering"
  | "crawling"
  | "extracting"
  | "checking_access"
  | "analyzing"
  | "scoring"
  | "done"
  | "failed"
  | "canceled";

export interface CrawlProgress {
  readonly stage: CrawlStage;
  readonly message: string;
  readonly pagesFound: number;
  readonly pagesCrawled: number;
  readonly currentUrl: string | null;
  readonly etaSeconds: number | null;
  /** Terminal status, once known — lets a late SSE subscriber finish immediately. */
  readonly status: string | null;
  readonly updatedAt: string;
}

export interface PromptRunProgress {
  readonly cellsDone: number;
  readonly cellsTotal: number;
  readonly status: string | null;
  readonly updatedAt: string;
}

/**
 * The unvisited frontier of an interrupted crawl.
 *
 * Operational state, so it lives in Redis: losing it costs a partial re-discovery, never
 * data. The snapshots already written are the durable half of the checkpoint — a crawl
 * whose frontier is gone still resumes, it just re-derives what it has left to do.
 */
export interface FrontierCheckpoint {
  readonly urls: readonly string[];
  readonly savedAt: string;
}

export interface ProgressStore {
  /** Saves the unvisited frontier so a killed crawl resumes rather than restarting. */
  saveFrontier(crawlId: string, urls: readonly string[]): Promise<void>;
  loadFrontier(crawlId: string): Promise<FrontierCheckpoint | null>;
  clearFrontier(crawlId: string): Promise<void>;
  setCrawlProgress(crawlId: string, progress: Partial<CrawlProgress>): Promise<void>;
  getCrawlProgress(crawlId: string): Promise<CrawlProgress | null>;
  setPromptRunProgress(runId: string, progress: Partial<PromptRunProgress>): Promise<void>;
  getPromptRunProgress(runId: string): Promise<PromptRunProgress | null>;
  /** Cancellation is a flag the running job polls at safe points (§7). */
  requestCancel(crawlId: string): Promise<void>;
  isCancelRequested(crawlId: string): Promise<boolean>;
  clear(crawlId: string): Promise<void>;
}
