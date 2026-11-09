/** Crawl reads and cancellation (docs/API.md §3 — Crawler group). */
import type { Page } from "../../contracts/api/common.js";
import type { Crawl } from "../../contracts/api/crawls.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { AppError as AppErrorClass, notFound } from "../../domain/shared/app-error.js";
import type {
  CrawlsRepo,
  PageSnapshotSummary,
} from "../../infrastructure/db/repositories/crawls.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { ProgressStore } from "../ports/progress-store.port.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadCrawlsDeps {
  readonly projects: ProjectsRepo;
  readonly crawls: CrawlsRepo;
  readonly progress: ProgressStore;
}

export async function listCrawls(
  deps: ReadCrawlsDeps,
  input: {
    readonly projectId: string;
    readonly userId: string;
    readonly limit: number;
    readonly cursor: string | undefined;
    readonly siteId: string | undefined;
  },
): Promise<Result<Page<Crawl>, AppError>> {
  const access = await assertProjectAccess(deps.projects, input.projectId, input.userId);
  if (!access.ok) return access;

  const rows = await deps.crawls.listForProject(
    input.projectId,
    input.limit + 1,
    input.cursor,
    input.siteId,
  );
  const data = rows.slice(0, input.limit);
  return ok({
    data,
    nextCursor: rows.length > input.limit ? (data.at(-1)?.id ?? null) : null,
  });
}

export async function getCrawl(
  deps: ReadCrawlsDeps,
  projectId: string,
  userId: string,
  crawlId: string,
): Promise<Result<Crawl, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const crawl = await deps.crawls.findInProject(projectId, crawlId);
  return crawl === null ? err(notFound("Crawl")) : ok(crawl);
}

export async function listCrawlPages(
  deps: ReadCrawlsDeps,
  input: {
    readonly projectId: string;
    readonly userId: string;
    readonly crawlId: string;
    readonly limit: number;
    readonly cursor: string | undefined;
    readonly changed: boolean | undefined;
  },
): Promise<Result<Page<PageSnapshotSummary>, AppError>> {
  const access = await assertProjectAccess(deps.projects, input.projectId, input.userId);
  if (!access.ok) return access;

  const crawl = await deps.crawls.findInProject(input.projectId, input.crawlId);
  if (crawl === null) return err(notFound("Crawl"));

  const rows = await deps.crawls.listSnapshots(
    input.crawlId,
    input.limit + 1,
    input.cursor,
    input.changed,
  );
  const data = rows.slice(0, input.limit);
  return ok({
    data,
    nextCursor: rows.length > input.limit ? (data.at(-1)?.id ?? null) : null,
  });
}

/**
 * Requests cancellation.
 *
 * The flag goes to Redis and the running job notices it at its next safe point; the crawl
 * then ends as CANCELED with everything captured so far retained. Cancelling a crawl that
 * has already finished is a 409 — the state is terminal and rewriting it would falsify
 * history (docs/API.md §3).
 */
export async function cancelCrawl(
  deps: ReadCrawlsDeps,
  projectId: string,
  userId: string,
  crawlId: string,
): Promise<Result<Crawl, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const crawl = await deps.crawls.findInProject(projectId, crawlId);
  if (crawl === null) return err(notFound("Crawl"));

  const active = crawl.status === "QUEUED" || crawl.status === "CRAWLING" || crawl.status === "ANALYZING";
  if (!active) {
    return err(
      new AppErrorClass("CRAWL_ALREADY_ACTIVE", {
        detail: `This crawl is already ${crawl.status.toLowerCase()} and cannot be canceled.`,
      }),
    );
  }

  await deps.progress.requestCancel(crawlId);

  // A crawl still QUEUED has no worker to notice the flag, so end it here.
  if (crawl.status === "QUEUED") {
    const canceled = await deps.crawls.finish(crawlId, "CANCELED", {
      errorReason: "Canceled before it started.",
    });
    await deps.progress.setCrawlProgress(crawlId, {
      stage: "canceled",
      message: "Crawl canceled.",
      status: "CANCELED",
    });
    return ok(canceled);
  }

  return ok(crawl);
}
