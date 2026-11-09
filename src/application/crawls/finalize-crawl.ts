/**
 * Finalizing a crawl: mark it terminal, record the event, and tell the progress stream to
 * stop (docs/Backend.md §4.1 fan-in).
 *
 * Separate from `runCrawl` because the fan-in eventually does much more — score, recommend,
 * summarize, invalidate the dashboard cache — and those arrive in later milestones without
 * touching the crawl loop. Today it does the honest minimum, and the `crawl_completed`
 * event it writes is what the History feed reads.
 */
import type { Crawl } from "../../contracts/api/crawls.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { EventsRepo } from "../../infrastructure/db/repositories/events.repo.js";
import type { ProgressStore } from "../ports/progress-store.port.js";

export interface FinalizeCrawlDeps {
  readonly crawls: CrawlsRepo;
  readonly events: EventsRepo;
  readonly progress: ProgressStore;
}

export interface FinalizeCrawlInput {
  readonly crawlId: string;
  readonly projectId: string;
  readonly pagesCrawled: number;
  readonly pagesChanged: number;
  readonly pagesFailed: number;
  /** Components that were attempted and failed — never "not run yet" (AI-Pipeline §5.2). */
  readonly degradation?: Record<string, unknown> | null;
}

/** More than this share of pages failing means the result is not worth presenting whole. */
const DEGRADED_FAILURE_RATIO = 0.2;

export async function finalizeCrawl(
  deps: FinalizeCrawlDeps,
  input: FinalizeCrawlInput,
): Promise<Crawl> {
  const attempted = input.pagesCrawled + input.pagesFailed;

  if (attempted === 0) {
    // Nothing was readable at all: that is a failure, and the user deserves the reason
    // rather than an empty dashboard.
    const failed = await deps.crawls.finish(input.crawlId, "FAILED", {
      errorReason:
        "We could not read any pages on this site. It may be unreachable, or it may be blocking our crawler.",
    });
    await deps.progress.setCrawlProgress(input.crawlId, {
      stage: "failed",
      message: "We could not read any pages on this site.",
      status: "FAILED",
    });
    await deps.events.record({
      projectId: input.projectId,
      kind: "crawl_failed",
      crawlId: input.crawlId,
      payload: { reason: "no_pages_readable" },
    });
    return failed;
  }

  const failureRatio = input.pagesFailed / attempted;
  const degraded =
    input.degradation !== undefined && input.degradation !== null
      ? true
      : failureRatio > DEGRADED_FAILURE_RATIO;

  const degradation =
    input.degradation ??
    (failureRatio > DEGRADED_FAILURE_RATIO
      ? { pages: { failed: input.pagesFailed, attempted } }
      : null);

  const crawl = await deps.crawls.finish(
    input.crawlId,
    degraded ? "COMPLETED_DEGRADED" : "COMPLETED",
    { degradation, errorReason: null },
  );

  await deps.progress.setCrawlProgress(input.crawlId, {
    stage: "done",
    message: `Done — we read ${input.pagesCrawled} page${input.pagesCrawled === 1 ? "" : "s"}.`,
    pagesCrawled: input.pagesCrawled,
    currentUrl: null,
    status: crawl.status,
  });

  await deps.events.record({
    projectId: input.projectId,
    kind: "crawl_completed",
    crawlId: input.crawlId,
    payload: {
      pagesCrawled: input.pagesCrawled,
      pagesChanged: input.pagesChanged,
      pagesFailed: input.pagesFailed,
      status: crawl.status,
    },
  });

  return crawl;
}
