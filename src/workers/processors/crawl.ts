/**
 * The crawl processor — a controller, and a peer of an HTTP route
 * (Engineering-Rules §2.2): resolve context, call exactly one use case, map the result.
 *
 * Failure policy lives here rather than in the use case because it is a *job* concern:
 * BullMQ retries a thrown error per the queue's policy, so a genuine fault must throw,
 * while a crawl that finished degraded must not.
 */
import type { CrawlJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import { runCrawl, type RunCrawlDeps } from "../../application/crawls/run-crawl.js";
import {
  startAnalysisFlow,
  type StartAnalysisFlowDeps,
} from "../../application/indexing/start-analysis-flow.js";
import {
  runAccessCheckForCrawl,
  type RunAccessCheckDeps,
} from "../../application/access-check/run-access-check.js";
import {
  generateTaxonomy,
  type GenerateTaxonomyDeps,
} from "../../application/analysis/generate-taxonomy.js";
import {
  generateTrackedPrompts,
  type GeneratePromptsDeps,
} from "../../application/prompt-sim/generate-prompts.js";

export interface CrawlProcessorDeps {
  /** Everything the pipeline needs, minus the per-job logger and stop signal. */
  readonly pipeline: Omit<RunCrawlDeps, "log" | "shouldStop">;
  readonly accessCheck: Omit<RunAccessCheckDeps, "log">;
  readonly taxonomy: Omit<GenerateTaxonomyDeps, "log">;
  /** True when the project has no taxonomy yet — generation runs once, not every crawl. */
  readonly needsTaxonomy: (projectId: string) => Promise<boolean>;
  readonly trackedPrompts: Omit<GeneratePromptsDeps, "log">;
  /** True when the project tracks no prompts yet. Never regenerated: history is the point. */
  readonly needsPrompts: (projectId: string) => Promise<boolean>;
  readonly analysis: Omit<StartAnalysisFlowDeps, "log">;
}

export function createCrawlProcessor(deps: CrawlProcessorDeps) {
  return async (job: CrawlJob, context: JobContext): Promise<void> => {
    const result = await runCrawl(
      { ...deps.pipeline, log: context.log, shouldStop: context.shouldStop },
      { crawlId: job.crawlId, projectId: job.projectId, siteId: job.siteId },
    );

    if (!result.ok) {
      // A missing crawl or site means the project was deleted mid-flight — nothing to
      // retry, and nothing broken.
      context.log.warn(
        { crawlId: job.crawlId, code: result.error.code },
        "crawl job resolved to nothing",
      );
      return;
    }

    await context.reportProgress({
      pagesCrawled: result.value.pagesCrawled,
      pagesChanged: result.value.pagesChanged,
      pagesFailed: result.value.pagesFailed,
    });

    if (result.value.canceled) return;

    // The access check is cheap HTTP work and the product's fastest aha moment, so it runs
    // on every crawl. A failure here degrades the analysis block; it never fails the crawl,
    // because a site that refuses our probes is precisely the finding we are looking for.
    try {
      const access = await runAccessCheckForCrawl(
        { ...deps.accessCheck, log: context.log },
        {
          crawlId: job.crawlId,
          projectId: job.projectId,
          siteId: job.siteId,
        },
      );
      if (!access.ok) {
        context.log.warn(
          { crawlId: job.crawlId, code: access.error.code },
          "access check could not run",
        );
      }
    } catch (error) {
      context.log.error({ crawlId: job.crawlId, err: error }, "access check failed");
    }

    // The taxonomy is generated once per project, after its first completed crawl. It is
    // the only frontier-tier call in this job, and everything downstream (coverage,
    // retrievability, prompt generation) stands on it.
    if (await deps.needsTaxonomy(job.projectId)) {
      const taxonomy = await generateTaxonomy(
        { ...deps.taxonomy, log: context.log },
        {
          projectId: job.projectId,
          crawlId: job.crawlId,
          siteId: job.siteId,
          ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
        },
      );
      if (!taxonomy.ok) {
        // Documented degradation (AI-Pipeline §9): the crawl still completes, and the
        // analysis records that the taxonomy is unavailable with a retry action.
        context.log.warn(
          { crawlId: job.crawlId, code: taxonomy.error.code },
          "taxonomy unavailable for this crawl",
        );
      }
    }

    // The tracked prompt set is seeded once, from the taxonomy, after the first crawl.
    // Regenerating it later would reset every trend line the account has accumulated.
    if (await deps.needsPrompts(job.projectId)) {
      const prompts = await generateTrackedPrompts(
        { ...deps.trackedPrompts, log: context.log },
        {
          projectId: job.projectId,
          crawlId: job.crawlId,
          siteId: job.siteId,
          ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
        },
      );
      if (!prompts.ok) {
        context.log.warn(
          { crawlId: job.crawlId, code: prompts.error.code },
          "tracked prompts unavailable for this project",
        );
      }
    }

    if (result.value.stoppedEarly && context.shouldStop()) {
      // Deliberately left ANALYZING-less and unfinished: the retry resumes from the
      // snapshots already written. Throwing schedules that retry.
      throw new Error("worker draining — crawl checkpointed for resume");
    }

    // Hand off to the analysis flow. The crawl is *not* finalized here any more: the
    // aggregate parent does that once indexing and coverage have settled (docs/Backend.md
    // §4.1), so a crawl is only ever COMPLETED when its analysis is genuinely done.
    await startAnalysisFlow(
      { ...deps.analysis, log: context.log },
      {
        crawlId: job.crawlId,
        projectId: job.projectId,
        siteId: job.siteId,
        trigger: job.trigger,
        ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
      },
    );
  };
}
