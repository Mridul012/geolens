/**
 * Gathering a report's content (M17).
 *
 * Runs inside the `report` job, so there is no session — the project id on the payload is
 * trusted the way every worker trusts its payload (§2.2: workers are peers of routes, not
 * lesser routes). What is *not* trusted as "latest" is the crawl and prompt run: those were
 * pinned onto the report row at request time, and this file reads exactly those ids so a
 * retried job reproduces the same document rather than one that quietly moved on.
 */
import { FRESHNESS_WINDOW_DAYS } from "../../config/scoring/content.js";
import { ACTIVE_COVERAGE_THRESHOLDS } from "../../config/scoring/coverage.v1.js";
import type { Report, ReportSection } from "../../contracts/api/reports.js";
import { comparisonMetrics } from "../../domain/comparison/metrics.js";
import { compareCoverage } from "../../domain/topics/coverage.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { ReportComparisonSide, ReportTemplateData } from "../../domain/reports/template.js";
import type { Clock } from "../ports/clock.port.js";
import type { ChunksRepo } from "../../infrastructure/db/repositories/chunks.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { RecommendationsRepo } from "../../infrastructure/db/repositories/recommendations.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";
import type { SiteFactsRepo } from "../../infrastructure/db/repositories/site-facts.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";

export interface AssembleReportDataDeps {
  readonly projects: ProjectsRepo;
  readonly sites: SitesRepo;
  readonly crawls: CrawlsRepo;
  readonly scores: ScoresRepo;
  readonly siteFacts: SiteFactsRepo;
  readonly chunks: ChunksRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
  readonly recommendations: RecommendationsRepo;
  readonly clock: Clock;
}

/** Rows on the trend table — a printed page has no room for thirty points. */
const TREND_POINTS = 12;
/** Recommendations listed — enough to act on, not a dump of the backlog. */
const RECOMMENDATION_LIMIT = 10;
/** Gaps listed under the comparison section. */
const MISSING_TOPIC_LIMIT = 8;

async function comparisonSide(
  deps: AssembleReportDataDeps,
  domain: string,
  crawlId: string | null,
  composite: number | null,
  freshSince: Date,
): Promise<ReportComparisonSide> {
  if (crawlId === null) {
    return { domain, aiVisibility: null, topicCoverage: null, authority: null };
  }
  const facts = await deps.siteFacts.comparisonFacts(crawlId, freshSince);
  const coverageRows = await deps.coverage.listForCrawl(crawlId);
  const meanCoverage =
    coverageRows.length === 0
      ? null
      : Math.round(coverageRows.reduce((sum, row) => sum + row.coverageScore, 0) / coverageRows.length);
  const metrics = comparisonMetrics({
    composite,
    topicCoverage: meanCoverage,
    trust: null,
    pagesIndexed: null,
    freshPages: facts.freshPages,
    datedPages: facts.datedPages,
    blogPages: facts.blogPages,
    pagesTotal: facts.pagesTotal,
    meanInternalLinks: facts.meanInternalLinks,
  });
  return {
    domain,
    aiVisibility: metrics.aiVisibility,
    topicCoverage: metrics.topicCoverage,
    authority: metrics.authority,
  };
}

export async function assembleReportData(
  deps: AssembleReportDataDeps,
  report: Report,
  projectId: string,
  sections: readonly ReportSection[],
): Promise<Result<ReportTemplateData, AppError>> {
  const project = await deps.projects.findAnyById(projectId);
  if (project === null) return err(notFound("Project"));

  const ownSite = project.sites.find((site) => site.role === "OWN") ?? null;

  const artifact =
    report.crawlId === null ? {} : ((await deps.crawls.findAnalysis(projectId, report.crawlId)) ?? {});
  const executiveSummary = artifact["executiveSummary"];
  const strengths = artifact["strengths"];
  const weaknesses = artifact["weaknesses"];
  const summary =
    typeof executiveSummary === "string" || Array.isArray(strengths) || Array.isArray(weaknesses)
      ? {
          executiveSummary: typeof executiveSummary === "string" ? executiveSummary : null,
          strengths: Array.isArray(strengths)
            ? strengths.filter((item): item is string => typeof item === "string")
            : [],
          weaknesses: Array.isArray(weaknesses)
            ? weaknesses.filter((item): item is string => typeof item === "string")
            : [],
        }
      : null;

  const scoreRow = report.crawlId === null ? null : await deps.scores.findForCrawl(report.crawlId);
  const trend = await deps.scores.recentTrend(projectId, TREND_POINTS);
  const recommendations = await deps.recommendations.topOpen(projectId, RECOMMENDATION_LIMIT);

  const activeTopics = await deps.topics.listForProject(projectId, "ACTIVE");
  const ownCoverage = new Map(
    (report.crawlId === null ? [] : await deps.coverage.listForCrawl(report.crawlId)).map((row) => [
      row.topicId,
      row,
    ]),
  );

  const [competitorSite] = await deps.sites.listForProject(projectId, "COMPETITOR");
  const competitorCrawlId =
    competitorSite === undefined ? null : await deps.crawls.findLatestCompleted(competitorSite.id);
  const rivalCoverage = new Map(
    (competitorCrawlId === null ? [] : await deps.coverage.listForCrawl(competitorCrawlId)).map(
      (row) => [row.topicId, row],
    ),
  );

  const freshSince = new Date(
    deps.clock.now().getTime() - FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const ownComparison = await comparisonSide(
    deps,
    ownSite?.domain ?? project.name,
    report.crawlId,
    scoreRow?.score.composite ?? null,
    freshSince,
  );
  const competitorComparison =
    competitorSite === undefined
      ? null
      : await comparisonSide(deps, competitorSite.domain, competitorCrawlId, null, freshSince);

  const missingTopics = compareCoverage(
    activeTopics.map((topic) => ({
      topicId: topic.id,
      label: topic.label,
      ownCoverage: ownCoverage.get(topic.id)?.coverageScore ?? null,
      ownDepth: ownCoverage.get(topic.id)?.depthChunks ?? null,
      competitorCoverage: rivalCoverage.get(topic.id)?.coverageScore ?? null,
    })),
    ACTIVE_COVERAGE_THRESHOLDS,
  )
    .filter((row) => row.missing)
    .slice(0, MISSING_TOPIC_LIMIT);

  return ok({
    projectName: project.name,
    domain: ownSite?.domain ?? "",
    generatedAt: deps.clock.now().toISOString(),
    sections,
    summary,
    score:
      scoreRow === null
        ? null
        : {
            composite: scoreRow.score.composite,
            citation: scoreRow.score.scoreCitation,
            retrievability: scoreRow.score.scoreRetrievability,
            contentQuality: scoreRow.score.scoreContentQuality,
            topicCoverage: scoreRow.score.scoreTopicCoverage,
            technical: scoreRow.score.scoreTechnical,
            trust: scoreRow.score.scoreTrust,
          },
    trend: [...trend],
    recommendations: recommendations.map((rec) => ({
      title: rec.title,
      priority: rec.priority,
      impact: rec.impact,
      difficulty: rec.difficulty,
    })),
    comparison: { own: ownComparison, competitor: competitorComparison, missingTopics: [...missingTopics] },
  });
}
