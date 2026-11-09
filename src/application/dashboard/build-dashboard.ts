/**
 * Building the dashboard payload (docs/Backend.md §4.1 — the fan-in "rebuilds the
 * dashboard cache").
 *
 * The architectural rule this file exists to keep: **the dashboard never computes.** The
 * read path serves one cached object; everything expensive — the score, the trend, the
 * page list, the coverage gaps — is assembled here, once, at the end of a crawl. That is
 * what makes the p95 a property of Redis rather than of the customer's page count.
 *
 * Building it is therefore allowed to be slow and to touch six repositories. Reading it
 * is not allowed to touch any.
 */
import type { Dashboard } from "../../contracts/api/dashboard.js";
import { compareCoverage } from "../../domain/topics/coverage.js";
import { ACTIVE_COVERAGE_THRESHOLDS } from "../../config/scoring/coverage.v1.js";
import type { Cache } from "../ports/cache.port.js";
import type { Clock } from "../ports/clock.port.js";
import type { ChunksRepo } from "../../infrastructure/db/repositories/chunks.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";
import type { RecommendationsRepo } from "../../infrastructure/db/repositories/recommendations.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";

export interface DashboardDeps {
  readonly cache: Cache;
  readonly clock: Clock;
  readonly crawls: CrawlsRepo;
  readonly scores: ScoresRepo;
  readonly sites: SitesRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
  readonly chunks: ChunksRepo;
  readonly recommendations: RecommendationsRepo;
  readonly runs: PromptRunsRepo;
}

/** Points on the trend chart. */
const TREND_POINTS = 30;
/** Pages listed in the "recently crawled" block. */
const RECENT_PAGES = 10;
/** Gaps shown before the user has to open the coverage page. */
const TOP_MISSING_TOPICS = 5;
/** Cards on the dashboard before the user has to open the recommendations page. */
const TOP_RECOMMENDATIONS = 5;

/**
 * A day. The cache is *written* by the pipeline on every crawl, so the TTL is a backstop
 * against an abandoned project's payload sitting in Redis forever — not a freshness
 * mechanism.
 */
export const DASHBOARD_TTL_SECONDS = 24 * 60 * 60;

export const dashboardKey = (projectId: string): string => `dashboard:${projectId}`;

export async function buildDashboard(
  deps: DashboardDeps,
  projectId: string,
): Promise<Dashboard> {
  const ownSite = await deps.sites.findOwnSite(projectId);
  const [latestCrawl] = await deps.crawls.listForProject(projectId, 1, undefined, undefined);
  const completedCrawlId =
    ownSite === null ? null : await deps.crawls.findLatestCompleted(ownSite.id);

  const latest = await deps.scores.findLatest(projectId);
  const latestRun = await deps.runs.findLatestCompleted(projectId);
  const trend = await deps.scores.recentTrend(projectId, TREND_POINTS);

  const recentPages =
    completedCrawlId === null
      ? []
      : await deps.crawls.listSnapshots(completedCrawlId, RECENT_PAGES, undefined, undefined);

  const indexing =
    completedCrawlId === null
      ? null
      : await deps.chunks.indexingCompleteness(completedCrawlId);

  // The coverage gaps, resolved the same way the coverage endpoint resolves them, so the
  // dashboard and the detail page can never disagree about which crawls they compare.
  const activeTopics = await deps.topics.listForProject(projectId, "ACTIVE");
  const ownCoverage = new Map(
    (completedCrawlId === null ? [] : await deps.coverage.listForCrawl(completedCrawlId)).map(
      (row) => [row.topicId, row],
    ),
  );

  let competitorCrawlId: string | null = null;
  for (const competitor of await deps.sites.listForProject(projectId, "COMPETITOR")) {
    const crawlId = await deps.crawls.findLatestCompleted(competitor.id);
    if (crawlId !== null) {
      competitorCrawlId = crawlId;
      break;
    }
  }
  const rivalCoverage = new Map(
    (competitorCrawlId === null ? [] : await deps.coverage.listForCrawl(competitorCrawlId)).map(
      (row) => [row.topicId, row],
    ),
  );

  const compared = compareCoverage(
    activeTopics.map((topic) => ({
      topicId: topic.id,
      label: topic.label,
      ownCoverage: ownCoverage.get(topic.id)?.coverageScore ?? null,
      ownDepth: ownCoverage.get(topic.id)?.depthChunks ?? null,
      competitorCoverage: rivalCoverage.get(topic.id)?.coverageScore ?? null,
    })),
    ACTIVE_COVERAGE_THRESHOLDS,
  );

  return {
    hasCompletedCrawl: completedCrawlId !== null,
    latestScore: latest?.score ?? null,
    scoreTrend: [...trend],
    crawlStatus: latestCrawl ?? null,
    indexedPages: indexing?.indexed ?? 0,
    recentPages: [...recentPages],
    topRecommendations: (
      await deps.recommendations.topOpen(projectId, TOP_RECOMMENDATIONS)
    ).map((row) => ({ ...row })),
    topMissingTopics: compared.slice(0, TOP_MISSING_TOPICS).map((row) => ({ ...row })),
    // Null means "no prompt run yet", not "zero mentions" — the UI renders those
    // differently and a customer would read a zero as lost visibility.
    promptSummary:
      latestRun === null
        ? null
        : {
            mentionRate: latestRun.mentionRate,
            citationShare: latestRun.citationShare,
            lastRunAt: latestRun.finishedAt,
          },
    comparisonSummary:
      competitorCrawlId === null
        ? null
        : {
            competitorCrawlId,
            missingTopics: compared.filter((row) => row.missing).length,
            biggestGap: compared[0]?.missing === true ? compared[0].label : null,
            shareOfVoice:
              typeof (latestRun?.metrics as { shareOfVoice?: unknown } | null)?.shareOfVoice ===
              "number"
                ? ((latestRun?.metrics as { shareOfVoice: number }).shareOfVoice)
                : null,
          },
    builtAt: deps.clock.now().toISOString(),
    projectId,
  };
}

/** Builds the payload and puts it in the cache. Called by the fan-in, never by a read. */
export async function rebuildDashboard(
  deps: DashboardDeps,
  projectId: string,
): Promise<Dashboard> {
  const dashboard = await buildDashboard(deps, projectId);
  await deps.cache.set(dashboardKey(projectId), dashboard, DASHBOARD_TTL_SECONDS);
  return dashboard;
}

/** Drops a project's cached payload — after a delete, a rename, or a competitor change. */
export async function invalidateDashboard(deps: DashboardDeps, projectId: string): Promise<void> {
  await deps.cache.delete(dashboardKey(projectId));
}
