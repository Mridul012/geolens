/**
 * The analysis fan-out (docs/Backend.md §4.1).
 *
 * Shape of the tree, and why:
 *
 * ```
 * aggregate (fan-in: finalizes the crawl)
 *   └── analyze: retrievability          ← the expensive one; needs the whole corpus
 *         └── analyze: topic-coverage        ← cheap, pure SQL over the same corpus
 *               ├── index (batch 1)          ← these run in parallel
 *               ├── index (batch 2)
 *               ├── …
 *               └── analyze: page-quality    ← needs snapshots, not chunks
 * ```
 *
 * Each analysis step is a *nested* parent rather than a sibling of the index jobs, because
 * siblings run concurrently: anything scheduled beside indexing would race its own inputs
 * and analyse a half-built corpus. Nesting makes the ordering a property of the flow rather
 * than a sleep or a poll.
 *
 * A BullMQ node has exactly one parent, so two analysis steps that both need the finished
 * corpus have to chain rather than fan out beside each other. Coverage runs first because
 * it is the cheap one: if the corpus is somehow unusable, that is discovered before the
 * simulation spends thirty judge calls finding out.
 *
 * Page quality is the exception that runs in parallel: it reads `page_snapshots`, which
 * already exist when the flow is submitted, so it sits beside the index children rather
 * than behind them. Thirty rubric calls and the embedding batches then overlap instead of
 * queueing.
 */
import { INDEX_BATCH_SIZE, JOB_PRIORITY } from "../../config/queues.js";
import { jobId } from "../../contracts/jobs/index.js";
import type { FlowNode, JobFlow } from "../ports/job-flow.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";

export interface StartAnalysisFlowDeps {
  readonly crawls: CrawlsRepo;
  readonly flow: JobFlow;
  readonly log: JobLogger;
}

export interface StartAnalysisFlowInput {
  readonly crawlId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly trigger: "MANUAL" | "SCHEDULED";
  readonly requestId?: string | undefined;
}

export interface StartAnalysisFlowResult {
  readonly indexBatches: number;
  readonly pagesQueued: number;
}

function batched<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export async function startAnalysisFlow(
  deps: StartAnalysisFlowDeps,
  input: StartAnalysisFlowInput,
): Promise<StartAnalysisFlowResult> {
  const targets = await deps.crawls.listIndexTargets(input.crawlId);
  const batches = batched(
    targets.map((target) => target.snapshotId),
    INDEX_BATCH_SIZE,
  );

  const requestId = input.requestId === undefined ? {} : { requestId: input.requestId };
  const priority =
    input.trigger === "MANUAL" ? JOB_PRIORITY.userTriggered : JOB_PRIORITY.scheduled;

  const indexChildren: FlowNode[] = batches.map((snapshotIds, batch) => ({
    queue: "index" as const,
    jobId: jobId.index(input.crawlId, batch),
    priority,
    payload: {
      crawlId: input.crawlId,
      projectId: input.projectId,
      siteId: input.siteId,
      snapshotIds,
      ...requestId,
    },
  }));

  // A crawl with no pages still gets the full tree: the analyze step records *why*
  // coverage is unavailable, and the aggregate still has to give the crawl a terminal
  // state. Skipping the flow here would leave it stuck in ANALYZING forever.
  const root: FlowNode = {
    queue: "aggregate",
    jobId: jobId.aggregate(input.crawlId),
    priority,
    payload: {
      crawlId: input.crawlId,
      projectId: input.projectId,
      siteId: input.siteId,
      ...requestId,
    },
    children: [
      {
        queue: "analyze",
        jobId: jobId.analyze(input.crawlId, "retrievability"),
        priority,
        payload: {
          crawlId: input.crawlId,
          projectId: input.projectId,
          siteId: input.siteId,
          task: "retrievability",
          ...requestId,
        },
        children: [
          {
            queue: "analyze",
            jobId: jobId.analyze(input.crawlId, "topic-coverage"),
            priority,
            payload: {
              crawlId: input.crawlId,
              projectId: input.projectId,
              siteId: input.siteId,
              task: "topic-coverage",
              ...requestId,
            },
            children: [
              ...indexChildren,
              {
                queue: "analyze" as const,
                jobId: jobId.analyze(input.crawlId, "page-quality"),
                priority,
                payload: {
                  crawlId: input.crawlId,
                  projectId: input.projectId,
                  siteId: input.siteId,
                  task: "page-quality" as const,
                  ...requestId,
                },
              },
            ],
          },
        ],
      },
    ],
  };

  await deps.flow.submit(root);

  deps.log.info(
    { crawlId: input.crawlId, indexBatches: batches.length, pages: targets.length },
    "analysis flow submitted",
  );

  return { indexBatches: batches.length, pagesQueued: targets.length };
}
