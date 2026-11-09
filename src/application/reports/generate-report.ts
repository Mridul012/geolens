/**
 * Generating a report's PDF (M17): assemble → render → store → mark ready.
 *
 * A thrown error here is a job concern (mirrors `workers/processors/crawl.ts`): BullMQ
 * retries per the queue's policy, so the row is marked FAILED first — a client polling
 * status must never see a report stuck in GENERATING forever — and the error is rethrown
 * so the retry still happens. A successful retry simply flips the row back through
 * GENERATING to READY.
 */
import { REPORT_SECTIONS } from "../../contracts/api/reports.js";
import { reportKey } from "../../domain/crawl/storage-keys.js";
import { renderReportHtml } from "../../domain/reports/template.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { Clock } from "../ports/clock.port.js";
import type { ObjectStorage } from "../ports/object-storage.port.js";
import type { PdfRenderer } from "../ports/pdf-renderer.port.js";
import type { ReportsRepo } from "../../infrastructure/db/repositories/reports.repo.js";
import { assembleReportData, type AssembleReportDataDeps } from "./assemble-report-data.js";

export interface GenerateReportDeps {
  readonly reports: ReportsRepo;
  readonly assemble: AssembleReportDataDeps;
  readonly renderer: PdfRenderer;
  readonly storage: ObjectStorage;
  readonly clock: Clock;
  readonly log: JobLogger;
}

export interface GenerateReportInput {
  readonly reportId: string;
  readonly projectId: string;
}

export interface GenerateReportResult {
  readonly reportId: string;
  readonly sizeBytes: number;
}

export async function generateReport(
  deps: GenerateReportDeps,
  input: GenerateReportInput,
): Promise<Result<GenerateReportResult | null, AppError>> {
  const report = await deps.reports.findInProject(input.projectId, input.reportId);
  if (report === null) {
    // The project or the report was deleted mid-flight — nothing to finalize.
    return ok(null);
  }

  await deps.reports.markGenerating(report.id);

  try {
    const storedSections = await deps.reports.sectionsFor(report.id);
    const sections = storedSections.length === 0 ? REPORT_SECTIONS : storedSections;

    const assembled = await assembleReportData(deps.assemble, report, input.projectId, sections);
    if (!assembled.ok) {
      await deps.reports.markFailed(report.id);
      return err(assembled.error);
    }

    const html = renderReportHtml(assembled.value);
    const pdf = await deps.renderer.renderPdf(html);
    const storageKey = reportKey(input.projectId, report.id);

    await deps.storage.put({ key: storageKey, body: pdf, contentType: "application/pdf" });
    await deps.reports.markReady(report.id, {
      storageKey,
      sizeBytes: pdf.byteLength,
      generatedAt: deps.clock.now(),
    });

    deps.log.info({ reportId: report.id, sizeBytes: pdf.byteLength }, "report generated");
    return ok({ reportId: report.id, sizeBytes: pdf.byteLength });
  } catch (error) {
    await deps.reports.markFailed(report.id);
    throw error;
  }
}
