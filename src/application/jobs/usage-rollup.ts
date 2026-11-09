/**
 * Usage rollup (docs/Backend.md §13): keeps `crawls.ai_cost_usd_micros` — documented as "a
 * rollup from ai_usage" (docs/Database.md §2.6) — actually populated. Nothing writes it at
 * crawl-finalize time today, so this hourly batch closes that gap for whatever has
 * accumulated since the last tick, a bounded number of crawls at a time.
 */
import type { JobLogger } from "../ports/job-context.port.js";
import type { AiUsageRepo } from "../../infrastructure/db/repositories/ai-usage.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";

export interface UsageRollupDeps {
  readonly crawls: CrawlsRepo;
  readonly aiUsage: AiUsageRepo;
  readonly log: JobLogger;
}

/** One tick's batch — bounded so a long backlog cannot turn an hourly job into an outage. */
const BATCH_LIMIT = 200;

export async function rollUpUsage(deps: UsageRollupDeps): Promise<{ readonly updated: number }> {
  const crawlIds = await deps.crawls.listMissingCostRollup(BATCH_LIMIT);

  for (const crawlId of crawlIds) {
    const total = await deps.aiUsage.totalForCrawl(crawlId);
    await deps.crawls.setCostRollup(crawlId, total);
  }

  deps.log.info({ updated: crawlIds.length }, "usage rollup complete");
  return { updated: crawlIds.length };
}
