/**
 * The analyze processor — per-crawl analysis steps that need the whole corpus.
 *
 * `task` is a closed union, so adding a step in a later milestone means adding a branch
 * here and a variant to the contract, never a string comparison that can silently miss.
 *
 * A degraded outcome does **not** throw: coverage that cannot be computed is a recorded
 * state, not a job failure, and retrying it three times would only re-record the same
 * unavailability while delaying the crawl's completion.
 */
import type { AnalyzeJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import { assertNever } from "../../domain/shared/result.js";
import {
  computeTopicCoverage,
  type ComputeTopicCoverageDeps,
} from "../../application/indexing/compute-topic-coverage.js";
import {
  simulateRetrievability,
  type SimulateRetrievabilityDeps,
} from "../../application/analysis/simulate-retrievability.js";
import {
  scorePageQuality,
  type ScorePageQualityDeps,
} from "../../application/analysis/score-page-quality.js";

export interface AnalyzeProcessorDeps {
  readonly coverage: Omit<ComputeTopicCoverageDeps, "log">;
  readonly retrievability: Omit<SimulateRetrievabilityDeps, "log">;
  readonly pageQuality: Omit<ScorePageQualityDeps, "log">;
}

export function createAnalyzeProcessor(deps: AnalyzeProcessorDeps) {
  return async (job: AnalyzeJob, context: JobContext): Promise<void> => {
    switch (job.task) {
      case "topic-coverage": {
        const result = await computeTopicCoverage(
          { ...deps.coverage, log: context.log },
          { projectId: job.projectId, crawlId: job.crawlId },
        );
        if (!result.ok) {
          context.log.warn(
            { crawlId: job.crawlId, code: result.error.code, reason: result.error.detail },
            "topic coverage unavailable for this crawl",
          );
          return;
        }
        await context.reportProgress({
          topicsScored: result.value.topicsScored,
          topicsCovered: result.value.topicsCovered,
        });
        return;
      }
      case "retrievability": {
        const result = await simulateRetrievability(
          { ...deps.retrievability, log: context.log },
          {
            projectId: job.projectId,
            crawlId: job.crawlId,
            siteId: job.siteId,
            ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
          },
        );
        if (!result.ok) {
          context.log.warn(
            { crawlId: job.crawlId, code: result.error.code, reason: result.error.detail },
            "retrievability unavailable for this crawl",
          );
          return;
        }
        await context.reportProgress({
          questionsTotal: result.value.questionsTotal,
          questionsAnswered: result.value.questionsAnswered,
          score: result.value.score,
        });
        return;
      }
      case "page-quality": {
        const result = await scorePageQuality(
          { ...deps.pageQuality, log: context.log },
          {
            projectId: job.projectId,
            crawlId: job.crawlId,
            ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
          },
        );
        if (!result.ok) {
          context.log.warn(
            { crawlId: job.crawlId, code: result.error.code },
            "page quality scoring resolved to nothing",
          );
          return;
        }
        await context.reportProgress({
          pagesSampled: result.value.pagesSampled,
          pagesScored: result.value.pagesScored,
        });
        return;
      }
      default:
        return assertNever(job.task);
    }
  };
}
