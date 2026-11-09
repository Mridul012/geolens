/**
 * Plan entitlements — the single source of truth for every limit the API enforces.
 *
 * Entitlements are resolved server-side from `subscriptions` at every enforcement point
 * and are never accepted from a client (docs/Backend.md §11). Limits live here so a gate
 * can never disagree with the number `/me` shows the user.
 *
 * Sources: PRD FR-2.2 (1 project free / 3 paid), FR-2.3 (one competitor per project),
 * FR-3.2 (100 pages per crawl, 25 on free), FR-7.1–7.2 (10 prompts, one on-demand run per
 * week on paid).
 */

export type PlanTier = "FREE" | "PRO";

export interface PlanLimits {
  /** Non-deleted projects the account may own. */
  readonly projects: number;
  /** Competitor sites per project (V2 raises this — PRD FR-2.5). */
  readonly competitorsPerProject: number;
  /** Hard page cap applied by the crawler, per crawl. */
  readonly pagesPerCrawl: number;
  /** ACTIVE prompt templates per project. */
  readonly activePrompts: number;
  /**
   * User-triggered prompt runs per rolling week. FREE curates prompts but cannot run
   * them: prompt tracking is the paid unlock (PRD business model; Open Question #3
   * resolved by the product owner on 2026-08-30 in favour of "curate free, runs are PRO").
   */
  readonly onDemandRunsPerWeek: number;
  /** User-triggered crawls per rolling week. */
  readonly onDemandCrawlsPerWeek: number;
  /** Scheduled weekly crawls and runs (PRD FR-3.7, FR-7.2 — paid only). */
  readonly scheduledRuns: boolean;
  /** PDF reports (PRD FR-12.1 — paid unlock). */
  readonly reports: boolean;
  /** Competitor comparison surface (paid unlock). */
  readonly comparison: boolean;
}

export const PLAN_LIMITS: Readonly<Record<PlanTier, PlanLimits>> = Object.freeze({
  FREE: Object.freeze({
    projects: 1,
    competitorsPerProject: 1,
    pagesPerCrawl: 25,
    activePrompts: 10,
    onDemandRunsPerWeek: 0,
    onDemandCrawlsPerWeek: 3,
    scheduledRuns: false,
    reports: false,
    comparison: false,
  }),
  PRO: Object.freeze({
    projects: 3,
    competitorsPerProject: 1,
    pagesPerCrawl: 100,
    activePrompts: 10,
    onDemandRunsPerWeek: 1,
    onDemandCrawlsPerWeek: 14,
    scheduledRuns: true,
    reports: true,
    comparison: true,
  }),
});

export function limitsFor(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan];
}
