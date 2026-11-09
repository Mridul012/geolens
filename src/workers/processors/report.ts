/**
 * The report processor — a controller, peer of an HTTP route (Engineering-Rules §2.2):
 * resolve context, call exactly one use case, map the result.
 */
import type { ReportJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import { generateReport, type GenerateReportDeps } from "../../application/reports/generate-report.js";

export type ReportProcessorDeps = Omit<GenerateReportDeps, "log">;

export function createReportProcessor(deps: ReportProcessorDeps) {
  return async (job: ReportJob, context: JobContext): Promise<void> => {
    const result = await generateReport(
      { ...deps, log: context.log },
      { reportId: job.reportId, projectId: job.projectId },
    );

    if (!result.ok) {
      context.log.warn(
        { reportId: job.reportId, code: result.error.code },
        "report generation resolved to an error",
      );
      return;
    }

    if (result.value === null) {
      context.log.warn({ reportId: job.reportId }, "report job resolved to nothing");
      return;
    }

    await context.reportProgress({ sizeBytes: result.value.sizeBytes });
  };
}
