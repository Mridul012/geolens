/**
 * Comparison metrics (docs/API.md §3 — ComparisonMetrics) — pure.
 *
 * Seven numbers per site, computed the same way for both. That symmetry is the whole
 * point: a comparison where the two columns were derived differently is not a comparison,
 * and the competitor is crawled by the identical pipeline precisely so this file can treat
 * it identically.
 *
 * Every metric is nullable, and null means "not measured", never zero. A competitor
 * crawled yesterday and one never crawled must not look the same on the page.
 */

export interface ComparisonFacts {
  /** The site's latest composite, when it has one. */
  readonly composite: number | null;
  readonly topicCoverage: number | null;
  readonly trust: number | null;
  readonly pagesIndexed: number | null;
  /** Pages with a publish or update date inside the freshness window. */
  readonly freshPages: number | null;
  readonly datedPages: number | null;
  /** Pages under a blog-shaped path. */
  readonly blogPages: number | null;
  readonly pagesTotal: number | null;
  /** Mean internal in-degree across the site's pages — a crude authority proxy. */
  readonly meanInternalLinks: number | null;
}

export interface ComparisonMetrics {
  readonly aiVisibility: number | null;
  readonly topicCoverage: number | null;
  readonly authority: number | null;
  readonly contentFreshness: number | null;
  readonly pageCount: number | null;
  readonly blogCoverage: number | null;
  readonly trustSignals: number | null;
}

/** A percentage, or null when there is no denominator to divide by. */
function share(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return Math.round(Math.min(100, (part / whole) * 100));
}

/**
 * Internal in-degree, mapped onto 0–100.
 *
 * Deliberately crude and deliberately capped: this is a *relative* signal on a comparison
 * page, not a claim about absolute authority. Twenty inbound links per page saturates it,
 * which is well above what a small site achieves and well below what a large one does —
 * so the metric separates a linked site from an unlinked one without pretending to rank
 * the whole web.
 */
const AUTHORITY_SATURATION = 20;

export function comparisonMetrics(facts: ComparisonFacts): ComparisonMetrics {
  return {
    aiVisibility: facts.composite,
    topicCoverage: facts.topicCoverage,
    authority:
      facts.meanInternalLinks === null
        ? null
        : Math.round(100 * Math.min(1, facts.meanInternalLinks / AUTHORITY_SATURATION)),
    // Of the pages that say when they were written, how many are recent. A site that dates
    // nothing scores null rather than zero — we cannot tell, which is not the same as stale.
    contentFreshness: share(facts.freshPages, facts.datedPages),
    pageCount: facts.pagesIndexed,
    blogCoverage: share(facts.blogPages, facts.pagesTotal),
    trustSignals: facts.trust,
  };
}

export interface ShareOfVoiceRow {
  readonly engine: string;
  readonly ownCitations: number;
  readonly competitorCitations: number;
  readonly shareOfVoice: number | null;
}

export interface ShareOfVoice {
  readonly overall: number | null;
  readonly perEngine: readonly ShareOfVoiceRow[];
  /** Citations by competitor domain, across the whole run. */
  readonly competitorCitations: Readonly<Record<string, number>>;
  readonly runId: string;
  readonly measuredAt: string | null;
}

/**
 * Reads share of voice out of a completed run's stored metrics.
 *
 * Read, not recomputed: the numbers a customer saw last week must not move because the
 * aggregation code changed since. The run row is the record.
 */
export function shareOfVoiceFrom(
  runId: string,
  measuredAt: string | null,
  metrics: Record<string, unknown>,
): ShareOfVoice {
  const perEngineRaw = Array.isArray(metrics["perEngine"])
    ? (metrics["perEngine"] as Array<Record<string, unknown>>)
    : [];

  const competitorCitations =
    typeof metrics["competitorCitations"] === "object" && metrics["competitorCitations"] !== null
      ? (metrics["competitorCitations"] as Record<string, number>)
      : {};

  return {
    overall: typeof metrics["shareOfVoice"] === "number" ? metrics["shareOfVoice"] : null,
    perEngine: perEngineRaw.map((engine) => ({
      engine: String(engine["engine"]),
      ownCitations: typeof engine["citations"] === "number" ? engine["citations"] : 0,
      competitorCitations:
        typeof engine["citations"] === "number" && typeof engine["shareOfVoice"] === "number"
          ? // The stored row keeps our citations and our share; the rival total follows.
            Math.max(
              0,
              Math.round(
                engine["shareOfVoice"] === 0
                  ? 0
                  : (engine["citations"] * 100) / engine["shareOfVoice"] - engine["citations"],
              ),
            )
          : 0,
      shareOfVoice:
        typeof engine["shareOfVoice"] === "number" ? engine["shareOfVoice"] : null,
    })),
    competitorCitations,
    runId,
    measuredAt,
  };
}
