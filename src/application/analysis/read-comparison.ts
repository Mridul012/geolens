/**
 * The comparison read (docs/API.md §3 — Competitors, §5.6).
 *
 * One request renders the whole page. The client performs zero joins, and "latest own
 * crawl versus latest competitor crawl" is resolved here — once — rather than in every
 * frontend that ever consumes this API. Two surfaces resolving it independently is how two
 * pages start disagreeing about which week they are showing.
 *
 * Every block is null-safe by construction, because a real account passes through all of
 * these states in its first hour: no competitor, a competitor added but not crawled, both
 * crawled but no prompt run yet. None of them is an error, and none of them is a zero.
 */
import { ACTIVE_COVERAGE_THRESHOLDS } from "../../config/scoring/coverage.v1.js";
import { FRESHNESS_WINDOW_DAYS } from "../../config/scoring/content.js";
import { limitsFor } from "../../config/plans.js";
import type { Comparison } from "../../contracts/api/comparison.js";
import {
  comparisonMetrics,
  shareOfVoiceFrom,
  type ComparisonMetrics,
} from "../../domain/comparison/metrics.js";
import { compareCoverage } from "../../domain/topics/coverage.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound, planLimitExceeded } from "../../domain/shared/app-error.js";
import type { Clock } from "../ports/clock.port.js";
import type { ChunksRepo } from "../../infrastructure/db/repositories/chunks.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";
import type { SiteFactsRepo } from "../../infrastructure/db/repositories/site-facts.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import type { Site } from "../../contracts/api/projects.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadComparisonDeps {
  readonly projects: ProjectsRepo;
  readonly sites: SitesRepo;
  readonly crawls: CrawlsRepo;
  readonly scores: ScoresRepo;
  readonly siteFacts: SiteFactsRepo;
  readonly chunks: ChunksRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
  readonly runs: PromptRunsRepo;
  readonly users: UsersRepo;
  readonly clock: Clock;
}

/** Gaps shown on the comparison page. */
const MISSING_TOPIC_LIMIT = 10;

const EMPTY_METRICS: ComparisonMetrics = {
  aiVisibility: null,
  topicCoverage: null,
  authority: null,
  contentFreshness: null,
  pageCount: null,
  blogCoverage: null,
  trustSignals: null,
};

export async function readComparison(
  deps: ReadComparisonDeps,
  projectId: string,
  userId: string,
): Promise<Result<Comparison, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const plan = await deps.users.findPlan(userId);
  if (!limitsFor(plan).comparison) {
    return err(planLimitExceeded(`Competitor comparison is not available on the ${plan} plan.`));
  }

  const ownSite = await deps.sites.findOwnSite(projectId);
  if (ownSite === null) return err(notFound("Site"));

  const [competitorSite] = await deps.sites.listForProject(projectId, "COMPETITOR");
  const freshSince = new Date(
    deps.clock.now().getTime() - FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  /** One column. Identical derivation for both sides — that symmetry is the whole point. */
  const columnFor = async (
    site: Site,
    compositeFrom: "project" | null,
  ): Promise<{ siteId: string; domain: string; name: string | null; crawlId: string | null; metrics: ComparisonMetrics }> => {
    const crawlId = await deps.crawls.findLatestCompleted(site.id);
    if (crawlId === null) {
      // Added but never crawled. Nulls, not zeros — the page must be able to say
      // "not measured yet" rather than "scores nothing".
      return { siteId: site.id, domain: site.domain, name: site.name, crawlId: null, metrics: EMPTY_METRICS };
    }

    const facts = await deps.siteFacts.comparisonFacts(crawlId, freshSince);
    const indexing = await deps.chunks.indexingCompleteness(crawlId);
    const coverageRows = await deps.coverage.listForCrawl(crawlId);
    const meanCoverage =
      coverageRows.length === 0
        ? null
        : Math.round(
            coverageRows.reduce((sum, row) => sum + row.coverageScore, 0) / coverageRows.length,
          );

    // A competitor has no score row of its own — scores belong to the project, not the
    // site — so only the own column carries a composite. Claiming one for a rival would
    // be inventing a number nobody computed.
    const latest = compositeFrom === "project" ? await deps.scores.findLatest(projectId) : null;

    return {
      siteId: site.id,
      domain: site.domain,
      name: site.name,
      crawlId,
      metrics: comparisonMetrics({
        composite: latest?.score.composite ?? null,
        topicCoverage: meanCoverage,
        trust: latest?.score.scoreTrust ?? null,
        pagesIndexed: indexing.indexed,
        freshPages: facts.freshPages,
        datedPages: facts.datedPages,
        blogPages: facts.blogPages,
        pagesTotal: facts.pagesTotal,
        meanInternalLinks: facts.meanInternalLinks,
      }),
    };
  };

  const own = await columnFor(ownSite, "project");
  const competitor = competitorSite === undefined ? null : await columnFor(competitorSite, null);

  // ── Missing topics, resolved exactly as the coverage endpoint resolves them ──
  const activeTopics = await deps.topics.listForProject(projectId, "ACTIVE");
  const ownCoverage = new Map(
    (own.crawlId === null ? [] : await deps.coverage.listForCrawl(own.crawlId)).map((row) => [
      row.topicId,
      row,
    ]),
  );
  const rivalCoverage = new Map(
    (competitor?.crawlId == null ? [] : await deps.coverage.listForCrawl(competitor.crawlId)).map(
      (row) => [row.topicId, row],
    ),
  );

  const missingTopics = compareCoverage(
    activeTopics.map((topic) => ({
      topicId: topic.id,
      label: topic.label,
      ownCoverage: ownCoverage.get(topic.id)?.coverageScore ?? null,
      ownDepth: ownCoverage.get(topic.id)?.depthChunks ?? null,
      competitorCoverage: rivalCoverage.get(topic.id)?.coverageScore ?? null,
    })),
    ACTIVE_COVERAGE_THRESHOLDS,
  ).slice(0, MISSING_TOPIC_LIMIT);

  // ── Share of voice, read from the latest completed run ──────────────────
  const latestRun = await deps.runs.findLatestCompleted(projectId);
  const voice =
    latestRun === null || latestRun.metrics === null
      ? null
      : shareOfVoiceFrom(latestRun.id, latestRun.finishedAt, latestRun.metrics);
  const shareOfVoice =
    voice === null ? null : { ...voice, perEngine: voice.perEngine.map((row) => ({ ...row })) };

  return ok({
    own,
    competitor,
    shareOfVoice,
    missingTopics: missingTopics.map((row) => ({ ...row })),
  });
}
