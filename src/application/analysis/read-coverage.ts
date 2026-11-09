/**
 * The topic coverage map: your latest crawl against a competitor's (docs/API.md §3).
 *
 * "Latest own vs latest competitor" is resolved here, once, on the server — the client
 * never joins two crawls (docs/API.md §5.6). Doing it anywhere else would mean two
 * frontends eventually disagreeing about which crawl a number came from.
 *
 * Every row is present even when a side has no data: a topic the user just added, on a
 * project whose first crawl has not finished, renders as nulls rather than as zeros. Zero
 * is a measurement; null is the absence of one.
 */
import { ACTIVE_COVERAGE_THRESHOLDS } from "../../config/scoring/coverage.v1.js";
import { compareCoverage, type CoverageInput } from "../../domain/topics/coverage.js";
import type { TopicCoverageResponse } from "../../contracts/api/coverage.js";
import type { Result } from "../../domain/shared/result.js";
import { ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { TopicsRepo } from "../../infrastructure/db/repositories/topics.repo.js";
import type { TopicCoverageRepo } from "../../infrastructure/db/repositories/topic-coverage.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadCoverageDeps {
  readonly projects: ProjectsRepo;
  readonly sites: SitesRepo;
  readonly crawls: CrawlsRepo;
  readonly topics: TopicsRepo;
  readonly coverage: TopicCoverageRepo;
}

export async function readTopicCoverage(
  deps: ReadCoverageDeps,
  projectId: string,
  userId: string,
): Promise<Result<TopicCoverageResponse, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const topics = await deps.topics.listForProject(projectId, "ACTIVE");
  const ownSite = await deps.sites.findOwnSite(projectId);
  const ownCrawlId = ownSite === null ? null : await deps.crawls.findLatestCompleted(ownSite.id);

  // One competitor, as the contract's single `competitorCrawlId` implies. The first
  // competitor with a completed crawl wins; M16 makes the choice explicit per request.
  let competitorCrawlId: string | null = null;
  for (const competitor of await deps.sites.listForProject(projectId, "COMPETITOR")) {
    const latest = await deps.crawls.findLatestCompleted(competitor.id);
    if (latest !== null) {
      competitorCrawlId = latest;
      break;
    }
  }

  const own = new Map(
    (ownCrawlId === null ? [] : await deps.coverage.listForCrawl(ownCrawlId)).map((row) => [
      row.topicId,
      row,
    ]),
  );
  const rival = new Map(
    (competitorCrawlId === null ? [] : await deps.coverage.listForCrawl(competitorCrawlId)).map(
      (row) => [row.topicId, row],
    ),
  );

  const rows: CoverageInput[] = topics.map((topic) => {
    const mine = own.get(topic.id);
    const theirs = rival.get(topic.id);
    return {
      topicId: topic.id,
      label: topic.label,
      ownCoverage: mine?.coverageScore ?? null,
      ownDepth: mine?.depthChunks ?? null,
      competitorCoverage: theirs?.coverageScore ?? null,
    };
  });

  return ok({
    ownCrawlId,
    competitorCrawlId,
    data: [...compareCoverage(rows, ACTIVE_COVERAGE_THRESHOLDS)],
  });
}
