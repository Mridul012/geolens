/**
 * The AI crawler access check (PRD FR-4, aha moment #1).
 *
 * Runs inside every crawl and costs nothing but a handful of HTTP requests. Its result is
 * merged into the crawl's analysis artifact and, when a bot is newly blocked or newly
 * allowed, written to the History feed — a site that starts blocking GPTBot should hear
 * about it, not discover it three months later.
 */
import type { AccessCheckResult } from "../../domain/crawl/access-check.js";
import { runAccessCheck as evaluate } from "../../domain/crawl/access-check.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";
import type { EventsRepo } from "../../infrastructure/db/repositories/events.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import type { AccessProber } from "../ports/access-prober.port.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobLogger } from "../ports/job-context.port.js";

export interface RunAccessCheckDeps {
  readonly crawls: CrawlsRepo;
  readonly sites: SitesRepo;
  readonly events: EventsRepo;
  readonly prober: AccessProber;
  readonly clock: Clock;
  readonly log: JobLogger;
}

export interface RunAccessCheckInput {
  readonly crawlId: string;
  readonly projectId: string;
  readonly siteId: string;
  /** The previous crawl's result, so newly-blocked bots can be reported as changes. */
  readonly previous?: AccessCheckResult | undefined;
}

export async function runAccessCheckForCrawl(
  deps: RunAccessCheckDeps,
  input: RunAccessCheckInput,
): Promise<Result<AccessCheckResult, AppError>> {
  const site = await deps.sites.findInProject(input.projectId, input.siteId);
  if (site === null) return err(notFound("Site"));

  const origin = new URL(site.url).origin;
  const evidence = await deps.prober.gather(origin);
  const result = evaluate({
    robots: evidence.robots,
    probes: evidence.probes,
    llmsTxtContent: evidence.llmsTxtContent,
    checkedAt: deps.clock.now(),
  });

  await deps.crawls.mergeAnalysis(input.crawlId, { accessCheck: result });

  const blocked = result.bots.filter((finding) => !finding.allowed);
  deps.log.info(
    {
      crawlId: input.crawlId,
      blocked: blocked.map((finding) => finding.bot),
      allowedShare: result.allowedShare,
      llmsTxt: result.llmsTxt.present,
    },
    "access check complete",
  );

  await recordChanges(deps, input, result);

  return ok(result);
}

/**
 * Writes History events only for bots whose access actually changed.
 *
 * On a first crawl there is nothing to compare against, so a blocked bot is reported once
 * as a finding rather than as a change — the feed is "what changed", and an initial state
 * is not a change.
 */
async function recordChanges(
  deps: RunAccessCheckDeps,
  input: RunAccessCheckInput,
  result: AccessCheckResult,
): Promise<void> {
  if (input.previous === undefined) {
    const blocked = result.bots.filter((finding) => !finding.allowed);
    if (blocked.length === 0) return;
    await deps.events.record({
      projectId: input.projectId,
      kind: "ai_crawler_blocked",
      crawlId: input.crawlId,
      payload: {
        bots: blocked.map((finding) => ({ bot: finding.bot, blockedBy: finding.blockedBy })),
        allowedShare: result.allowedShare,
        first: true,
      },
    });
    return;
  }

  const before = new Map(input.previous.bots.map((finding) => [finding.bot, finding.allowed]));
  const newlyBlocked = result.bots.filter(
    (finding) => !finding.allowed && before.get(finding.bot) === true,
  );
  const newlyAllowed = result.bots.filter(
    (finding) => finding.allowed && before.get(finding.bot) === false,
  );

  if (newlyBlocked.length > 0) {
    await deps.events.record({
      projectId: input.projectId,
      kind: "ai_crawler_blocked",
      crawlId: input.crawlId,
      payload: {
        bots: newlyBlocked.map((finding) => ({
          bot: finding.bot,
          blockedBy: finding.blockedBy,
        })),
        allowedShare: result.allowedShare,
        first: false,
      },
    });
  }

  if (newlyAllowed.length > 0) {
    await deps.events.record({
      projectId: input.projectId,
      kind: "ai_crawler_unblocked",
      crawlId: input.crawlId,
      payload: {
        bots: newlyAllowed.map((finding) => finding.bot),
        allowedShare: result.allowedShare,
      },
    });
  }
}
