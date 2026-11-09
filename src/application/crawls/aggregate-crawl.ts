/**
 * The fan-in (docs/Backend.md §4.1): the last thing that happens to a crawl.
 *
 * Its job is to look at what the children actually produced and give the crawl an honest
 * terminal state. Children that failed after their retries were dropped from the parent's
 * dependency set rather than failing the whole flow, so "the aggregate ran" does not mean
 * "everything succeeded" — this is where that difference is turned into a `degradation`
 * the API and the UI can explain.
 *
 * As of M12 it does the full fan-in (docs/Backend.md §4.1): assess what the children
 * produced, compute the versioned composite score, write the executive summary, mark the
 * crawl terminal, record the events, and rebuild the dashboard cache. M13 adds the
 * recommendations engine and M18 the notification.
 *
 * Order matters and is not arbitrary. The score is computed *before* the crawl is
 * finalized so that a dashboard rebuilt at the end sees it; the summary is written after
 * the score because it describes it; and the cache is rebuilt last, once everything it
 * reads has been written.
 */
import type { Crawl } from "../../contracts/api/crawls.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { JobLogger } from "../ports/job-context.port.js";
import { finalizeCrawl, type FinalizeCrawlDeps } from "./finalize-crawl.js";
import { computeScore, type ComputeScoreDeps } from "../scoring/compute-score.js";
import {
  generateExecSummary,
  type GenerateExecSummaryDeps,
} from "../analysis/generate-exec-summary.js";
import { rebuildDashboard, type DashboardDeps } from "../dashboard/build-dashboard.js";
import {
  generateRecommendations,
  type GenerateRecommendationsDeps,
} from "../recommendations/generate-recommendations.js";
import type { JobQueue } from "../ports/job-queue.port.js";
import type { ChunksRepo } from "../../infrastructure/db/repositories/chunks.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import { jobId } from "../../contracts/jobs/index.js";
import { JOB_PRIORITY } from "../../config/queues.js";

export interface AggregateCrawlDeps extends FinalizeCrawlDeps {
  readonly crawls: CrawlsRepo;
  readonly chunks: ChunksRepo;
  readonly log: JobLogger;
  /** Scoring, the summary and the cache rebuild. Omitted only in focused tests. */
  readonly scoring?: Omit<ComputeScoreDeps, "log"> | undefined;
  readonly recommendations?: Omit<GenerateRecommendationsDeps, "log"> | undefined;
  readonly summary?: Omit<GenerateExecSummaryDeps, "log"> | undefined;
  readonly dashboard?: DashboardDeps | undefined;
  /** Enqueues the crawl-complete email (docs/Backend.md §4.1). Omitted only in focused tests. */
  readonly notify?: { readonly queue: JobQueue } | undefined;
}

export interface AggregateCrawlInput {
  readonly crawlId: string;
  readonly projectId: string;
  readonly siteId?: string | undefined;
  readonly requestId?: string | undefined;
}

/** Statuses that mean somebody else already decided this crawl's fate. */
const TERMINAL: readonly Crawl["status"][] = [
  "COMPLETED",
  "COMPLETED_DEGRADED",
  "FAILED",
  "CANCELED",
];

/** Reads a `{ available: false, reason }` block out of the analysis artifact. */
function unavailableReason(analysis: Record<string, unknown>, key: string): string | null {
  const block = analysis[key];
  if (typeof block !== "object" || block === null) return null;
  const record = block as { available?: unknown; reason?: unknown };
  if (record.available !== false) return null;
  return typeof record.reason === "string" ? record.reason : "unavailable";
}

export async function aggregateCrawl(
  deps: AggregateCrawlDeps,
  input: AggregateCrawlInput,
): Promise<Result<Crawl, AppError>> {
  const crawl = await deps.crawls.findInProject(input.projectId, input.crawlId);
  if (crawl === null) return err(notFound("Crawl"));

  if (TERMINAL.includes(crawl.status)) {
    // A cancel that landed while the flow was in flight, or a duplicate delivery. Either
    // way the crawl already has an answer and re-finalizing would rewrite history.
    deps.log.info(
      { crawlId: input.crawlId, status: crawl.status },
      "aggregate skipped — crawl already terminal",
    );
    return ok(crawl);
  }

  const analysis = (await deps.crawls.findAnalysis(input.projectId, input.crawlId)) ?? {};
  const degradation: Record<string, unknown> = {};

  for (const component of ["taxonomy", "topicCoverage", "retrievability", "accessCheck"]) {
    const reason = unavailableReason(analysis, component);
    if (reason !== null) degradation[component] = reason;
  }

  // Indexing has no artifact block of its own, so its completeness is measured directly:
  // pages with readable prose versus pages that produced chunks.
  const indexing = await deps.chunks.indexingCompleteness(input.crawlId);
  if (indexing.indexed < indexing.expected) {
    degradation["indexing"] = {
      pagesIndexed: indexing.indexed,
      pagesExpected: indexing.expected,
    };
  }

  // ── Score, then summarize ─────────────────────────────────────────────────
  // Both run before the crawl is finalized: a dashboard rebuilt at the end must see the
  // score, and a summary that describes a score must be written after it.
  let composite: number | null = null;
  let componentsPayload: Record<string, unknown> = {};

  if (deps.scoring !== undefined) {
    const scored = await computeScore(
      { ...deps.scoring, log: deps.log },
      { projectId: input.projectId, crawlId: input.crawlId },
    );
    if (scored.ok) {
      composite = scored.value.score?.composite ?? null;
      componentsPayload = scored.value.components;
      if (!scored.value.published) {
        // Not degradation: a first crawl legitimately lacks the citation component, and
        // "score pending" is the documented state (AI-Pipeline §5.2).
        degradation["score"] = { published: false, totalWeight: scored.value.totalWeight };
      }
    } else {
      deps.log.warn(
        { crawlId: input.crawlId, code: scored.error.code },
        "scoring produced nothing for this crawl",
      );
    }
  }

  // Recommendations sit between the two: they read the score's component breakdown, and
  // the summary is better for knowing what the top recommendation turned out to be.
  if (deps.recommendations !== undefined && input.siteId !== undefined) {
    const recommended = await generateRecommendations(
      { ...deps.recommendations, log: deps.log },
      {
        projectId: input.projectId,
        crawlId: input.crawlId,
        siteId: input.siteId,
        composite,
        components: componentsPayload,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    );
    if (!recommended.ok) {
      deps.log.warn(
        { crawlId: input.crawlId, code: recommended.error.code },
        "recommendations produced nothing for this crawl",
      );
    }
  }

  if (deps.summary !== undefined && input.siteId !== undefined) {
    const summarised = await generateExecSummary(
      { ...deps.summary, log: deps.log },
      {
        projectId: input.projectId,
        crawlId: input.crawlId,
        siteId: input.siteId,
        composite,
        components: componentsPayload,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    );
    if (!summarised.ok) degradation["executiveSummary"] = "generation_failed";
  }

  const finalized = await finalizeCrawl(deps, {
    crawlId: input.crawlId,
    projectId: input.projectId,
    pagesCrawled: crawl.stats.pagesCrawled,
    pagesChanged: crawl.stats.pagesChanged,
    pagesFailed: crawl.stats.pagesFailed,
    degradation: Object.keys(degradation).length === 0 ? null : degradation,
  });

  // ── Publish ───────────────────────────────────────────────────────────────
  if (composite !== null) {
    await deps.events.record({
      projectId: input.projectId,
      kind: "score_changed",
      crawlId: input.crawlId,
      payload: { composite, configVersion: componentsPayload["configVersion"] ?? null },
    });
  }

  if (deps.dashboard !== undefined) {
    // Last, once everything it reads has been written. A failure here costs a stale
    // dashboard until the next crawl, never the crawl's result.
    try {
      await rebuildDashboard(deps.dashboard, input.projectId);
    } catch (error) {
      deps.log.error({ crawlId: input.crawlId, err: error }, "dashboard rebuild failed");
    }
  }

  // Last of all: the customer's inbox reflects a crawl that is genuinely, fully done —
  // scored, summarised, cached — never a "complete" email that beats the dashboard to it.
  if (deps.notify !== undefined && finalized.status !== "FAILED" && finalized.status !== "CANCELED") {
    await deps.notify.queue.enqueue(
      "notify",
      { task: "crawl-complete", payload: { projectId: input.projectId, crawlId: input.crawlId } },
      { jobId: jobId.notifyCrawlComplete(input.crawlId), priority: JOB_PRIORITY.scheduled },
    );
  }

  deps.log.info(
    { crawlId: input.crawlId, status: finalized.status, composite, degradation },
    "crawl aggregated",
  );

  return ok(finalized);
}
