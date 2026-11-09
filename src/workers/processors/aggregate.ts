/**
 * The aggregate processor — the flow's fan-in, and the crawl's last word.
 *
 * It is deliberately the *only* place a crawl reaches a terminal state after a successful
 * crawl phase, so "who marked this COMPLETED?" always has one answer.
 */
import type { AggregateJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import {
  aggregateCrawl,
  type AggregateCrawlDeps,
} from "../../application/crawls/aggregate-crawl.js";

export type AggregateProcessorDeps = Omit<AggregateCrawlDeps, "log">;

export function createAggregateProcessor(deps: AggregateProcessorDeps) {
  return async (job: AggregateJob, context: JobContext): Promise<void> => {
    const result = await aggregateCrawl(
      { ...deps, log: context.log },
      {
        crawlId: job.crawlId,
        projectId: job.projectId,
        siteId: job.siteId,
        ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
      },
    );

    if (!result.ok) {
      // The crawl or its project was deleted while the flow ran. Nothing to finalize.
      context.log.warn(
        { crawlId: job.crawlId, code: result.error.code },
        "aggregate resolved to nothing",
      );
      return;
    }

    await context.reportProgress({ status: result.value.status });
  };
}
