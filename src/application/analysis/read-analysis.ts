/**
 * The analysis read (docs/API.md §3 — GET /crawls/{id}/analysis).
 *
 * Serves the precomputed artifact; it never computes (Engineering-Rules §13). Blocks that
 * later milestones produce come back null until they exist, which is the contract's
 * documented empty state rather than a gap.
 */
import type { AnalysisReport } from "../../contracts/api/analysis.js";
import {
  accessCheckSchema,
  retrievabilitySchema,
  technicalIssueSchema,
} from "../../contracts/api/analysis.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { AppError as AppErrorClass, notFound } from "../../domain/shared/app-error.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadAnalysisDeps {
  readonly projects: ProjectsRepo;
  readonly crawls: CrawlsRepo;
}

/** Statuses whose analysis is meaningful to read. */
const READABLE = new Set(["COMPLETED", "COMPLETED_DEGRADED", "ANALYZING"]);

function parseBlock<T>(
  raw: unknown,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): T | null {
  if (raw === undefined || raw === null) return null;
  const parsed = schema.safeParse(raw);
  // A stored block written by an older pipeline that no longer matches the contract is
  // dropped rather than served — a malformed finding is worse than a missing one.
  return parsed.success ? (parsed.data as T) : null;
}

export async function getAnalysis(
  deps: ReadAnalysisDeps,
  projectId: string,
  userId: string,
  crawlId: string,
): Promise<Result<AnalysisReport, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const crawl = await deps.crawls.findInProject(projectId, crawlId);
  if (crawl === null) return err(notFound("Crawl"));

  if (!READABLE.has(crawl.status)) {
    // Documented 409: there is nothing to analyse yet, and an empty payload would read as
    // "we looked and found nothing".
    return err(
      new AppErrorClass("CRAWL_ALREADY_ACTIVE", {
        detail: `This crawl is ${crawl.status.toLowerCase()}; analysis is available once it has run.`,
      }),
    );
  }

  const artifact = (await deps.crawls.findAnalysis(projectId, crawlId)) ?? {};

  const summary = artifact["executiveSummary"];
  const strengths = artifact["strengths"];
  const weaknesses = artifact["weaknesses"];
  const issues = artifact["technicalIssues"];

  return ok({
    crawlId,
    executiveSummary: typeof summary === "string" ? summary : null,
    strengths: Array.isArray(strengths) ? strengths.filter((item): item is string => typeof item === "string") : [],
    weaknesses: Array.isArray(weaknesses)
      ? weaknesses.filter((item): item is string => typeof item === "string")
      : [],
    accessCheck: parseBlock(artifact["accessCheck"], accessCheckSchema),
    // An `{ available: false }` block fails this schema and reads as null, which is the
    // contract's honest empty state; the reason surfaces through `degradation`.
    retrievability: parseBlock(artifact["retrievability"], retrievabilitySchema),
    structuredDataHealth:
      (artifact["structuredDataHealth"] as Record<string, unknown> | undefined) ?? null,
    technicalIssues: Array.isArray(issues)
      ? issues.flatMap((item) => {
          const parsed = technicalIssueSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    degradation: crawl.degradation,
  });
}
