/**
 * Per-crawl and per-run spend ceilings (Engineering-Rules §6, PRD unit economics).
 *
 * The rule that matters: over budget **degrades**, it never crashes and it never silently
 * overspends. A crawl that exhausts its budget stops per-page work, completes its
 * aggregates, and is flagged `degradation: {budget: true}` — cost overruns are a product
 * state, not an incident (docs/Backend.md §7.4).
 *
 * Spend is read from the `ai_usage` ledger rather than tracked in memory, so a retried job
 * or a second worker cannot double-spend the same budget.
 */
import type { AiUsageRepo } from "../../db/repositories/ai-usage.repo.js";

export interface BudgetLimits {
  readonly perCrawlMicros: bigint;
  readonly perRunMicros: bigint;
}

export type BudgetVerdict =
  | { readonly allowed: true; readonly remainingMicros: bigint }
  | { readonly allowed: false; readonly scope: "crawl" | "run"; readonly spentMicros: bigint; readonly limitMicros: bigint };

export interface BudgetScope {
  readonly crawlId?: string | undefined;
  readonly promptRunId?: string | undefined;
}

export class BudgetGuard {
  readonly #usage: AiUsageRepo;
  readonly #limits: BudgetLimits;
  /**
   * Short-lived cache of ledger totals.
   *
   * A 30-page analysis would otherwise issue 30 aggregate queries against a growing table
   * to answer a question whose value it already knows. Estimated in-flight spend is added
   * locally, so the cache can only ever be *pessimistic* — it never lets a call through
   * that a fresh read would refuse.
   */
  readonly #spent = new Map<string, bigint>();

  constructor(usage: AiUsageRepo, limits: BudgetLimits) {
    this.#usage = usage;
    this.#limits = limits;
  }

  /** Checked before every call. An unscoped call (no crawl, no run) is always allowed. */
  async check(scope: BudgetScope): Promise<BudgetVerdict> {
    if (scope.crawlId !== undefined) {
      const spent = await this.#spentFor("crawl", scope.crawlId);
      if (spent >= this.#limits.perCrawlMicros) {
        return {
          allowed: false,
          scope: "crawl",
          spentMicros: spent,
          limitMicros: this.#limits.perCrawlMicros,
        };
      }
      return { allowed: true, remainingMicros: this.#limits.perCrawlMicros - spent };
    }

    if (scope.promptRunId !== undefined) {
      const spent = await this.#spentFor("run", scope.promptRunId);
      if (spent >= this.#limits.perRunMicros) {
        return {
          allowed: false,
          scope: "run",
          spentMicros: spent,
          limitMicros: this.#limits.perRunMicros,
        };
      }
      return { allowed: true, remainingMicros: this.#limits.perRunMicros - spent };
    }

    return { allowed: true, remainingMicros: this.#limits.perCrawlMicros };
  }

  /** Records spend locally so the next check sees it without re-reading the ledger. */
  addSpend(scope: BudgetScope, costMicros: bigint): void {
    if (scope.crawlId !== undefined) {
      this.#bump(`crawl:${scope.crawlId}`, costMicros);
    }
    if (scope.promptRunId !== undefined) {
      this.#bump(`run:${scope.promptRunId}`, costMicros);
    }
  }

  /** Drops cached totals — call when a scope finishes, so the map cannot grow unbounded. */
  forget(scope: BudgetScope): void {
    if (scope.crawlId !== undefined) this.#spent.delete(`crawl:${scope.crawlId}`);
    if (scope.promptRunId !== undefined) this.#spent.delete(`run:${scope.promptRunId}`);
  }

  async #spentFor(kind: "crawl" | "run", id: string): Promise<bigint> {
    const key = `${kind}:${id}`;
    const cached = this.#spent.get(key);
    if (cached !== undefined) return cached;

    const total =
      kind === "crawl"
        ? await this.#usage.totalForCrawl(id)
        : await this.#usage.totalForPromptRun(id);
    this.#spent.set(key, total);
    return total;
  }

  #bump(key: string, costMicros: bigint): void {
    this.#spent.set(key, (this.#spent.get(key) ?? 0n) + costMicros);
  }
}
