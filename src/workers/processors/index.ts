/**
 * The index processor — a controller (Engineering-Rules §2.2): validate context, call one
 * use case, map the result.
 *
 * Failure policy is a job concern and lives here. A batch whose snapshots have vanished is
 * not an error — the project was deleted mid-flight, and retrying cannot help. Anything
 * else throws, so BullMQ retries per the queue's policy and the flow's
 * `ignoreDependencyOnFailure` lets the fan-in proceed once the attempts are spent.
 */
import type { IndexJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import { indexPages, type IndexPagesDeps } from "../../application/indexing/index-pages.js";

export type IndexProcessorDeps = Omit<IndexPagesDeps, "log">;

export function createIndexProcessor(deps: IndexProcessorDeps) {
  return async (job: IndexJob, context: JobContext): Promise<void> => {
    const result = await indexPages(
      { ...deps, log: context.log },
      {
        crawlId: job.crawlId,
        projectId: job.projectId,
        snapshotIds: job.snapshotIds,
        ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
      },
    );

    if (!result.ok) {
      context.log.warn(
        { crawlId: job.crawlId, code: result.error.code },
        "index batch resolved to nothing",
      );
      return;
    }

    await context.reportProgress({
      pagesIndexed: result.value.pagesIndexed,
      pagesCarriedForward: result.value.pagesCarriedForward,
      chunksWritten: result.value.chunksWritten,
      embeddingsStored: result.value.embeddingsStored,
    });
  };
}
