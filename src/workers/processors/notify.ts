/**
 * The notify processor — a controller, peer of an HTTP route (Engineering-Rules §2.2).
 */
import type { NotifyJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import {
  notifyCrawlComplete,
  type NotifyCrawlCompleteDeps,
} from "../../application/notifications/notify-crawl-complete.js";
import { sendDigest, type SendDigestDeps } from "../../application/notifications/send-digest.js";
import { assertNever } from "../../domain/shared/result.js";

export interface NotifyProcessorDeps {
  readonly crawlComplete: Omit<NotifyCrawlCompleteDeps, "log">;
  readonly digest: Omit<SendDigestDeps, "log">;
}

export function createNotifyProcessor(deps: NotifyProcessorDeps) {
  return async (job: NotifyJob, context: JobContext): Promise<void> => {
    switch (job.task) {
      case "crawl-complete": {
        const result = await notifyCrawlComplete(
          { ...deps.crawlComplete, log: context.log },
          { projectId: job.payload.projectId, crawlId: job.payload.crawlId },
        );
        if (!result.ok) {
          context.log.warn(
            { projectId: job.payload.projectId, code: result.error.code },
            "crawl-complete email resolved to nothing",
          );
        }
        return;
      }
      case "weekly-digest": {
        const result = await sendDigest(
          { ...deps.digest, log: context.log },
          { projectId: job.payload.projectId },
        );
        if (!result.ok) {
          context.log.warn(
            { projectId: job.payload.projectId, code: result.error.code },
            "digest resolved to nothing",
          );
        }
        return;
      }
      default:
        assertNever(job);
    }
  };
}
