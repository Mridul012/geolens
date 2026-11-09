/**
 * Comparison metrics (docs/API.md §3 — ComparisonMetrics) — pure-function tests.
 *
 * The rule under test throughout: a metric is null when there is nothing to measure, never
 * zero. A zero on this page reads as "worse than everyone", so a missing denominator must
 * never be silently coerced into one.
 */
import { describe, expect, it } from "vitest";
import {
  comparisonMetrics,
  shareOfVoiceFrom,
  type ComparisonFacts,
} from "../../../src/domain/comparison/metrics.js";

const FULL_FACTS: ComparisonFacts = {
  composite: 72,
  topicCoverage: 65,
  trust: 80,
  pagesIndexed: 40,
  freshPages: 12,
  datedPages: 20,
  blogPages: 8,
  pagesTotal: 40,
  meanInternalLinks: 10,
};

const EMPTY_FACTS: ComparisonFacts = {
  composite: null,
  topicCoverage: null,
  trust: null,
  pagesIndexed: null,
  freshPages: null,
  datedPages: null,
  blogPages: null,
  pagesTotal: null,
  meanInternalLinks: null,
};

describe("comparisonMetrics", () => {
  it("passes composite, topicCoverage, and trust straight through", () => {
    const result = comparisonMetrics(FULL_FACTS);
    expect(result.aiVisibility).toBe(72);
    expect(result.topicCoverage).toBe(65);
    expect(result.trustSignals).toBe(80);
    expect(result.pageCount).toBe(40);
  });

  it("caps authority at 100 once mean internal links reach the saturation point", () => {
    expect(comparisonMetrics({ ...FULL_FACTS, meanInternalLinks: 20 }).authority).toBe(100);
    expect(comparisonMetrics({ ...FULL_FACTS, meanInternalLinks: 40 }).authority).toBe(100);
  });

  it("scales authority linearly below saturation", () => {
    expect(comparisonMetrics({ ...FULL_FACTS, meanInternalLinks: 10 }).authority).toBe(50);
    expect(comparisonMetrics({ ...FULL_FACTS, meanInternalLinks: 0 }).authority).toBe(0);
  });

  it("computes contentFreshness as a share of dated pages, not of all pages", () => {
    // 12 of 20 dated pages are fresh — the 20 undated pages are excluded from the denominator.
    expect(comparisonMetrics(FULL_FACTS).contentFreshness).toBe(60);
  });

  it("computes blogCoverage as a share of the whole site", () => {
    expect(comparisonMetrics(FULL_FACTS).blogCoverage).toBe(20);
  });

  it("returns null shares rather than zero when the denominator is zero or missing", () => {
    const noDatedPages = comparisonMetrics({ ...FULL_FACTS, datedPages: 0, freshPages: 0 });
    expect(noDatedPages.contentFreshness).toBeNull();

    const noPagesAtAll = comparisonMetrics({ ...FULL_FACTS, pagesTotal: 0, blogPages: 0 });
    expect(noPagesAtAll.blogCoverage).toBeNull();
  });

  it("is entirely null for a site with no facts at all — never zero", () => {
    const result = comparisonMetrics(EMPTY_FACTS);
    expect(result.aiVisibility).toBeNull();
    expect(result.topicCoverage).toBeNull();
    expect(result.authority).toBeNull();
    expect(result.contentFreshness).toBeNull();
    expect(result.pageCount).toBeNull();
    expect(result.blogCoverage).toBeNull();
    expect(result.trustSignals).toBeNull();
  });
});

describe("shareOfVoiceFrom", () => {
  it("reads overall share and per-engine rows out of a run's stored metrics", () => {
    const result = shareOfVoiceFrom("run-1", "2026-09-01T00:00:00.000Z", {
      shareOfVoice: 42,
      perEngine: [
        { engine: "perplexity", citations: 10, shareOfVoice: 50 },
        { engine: "openai", citations: 4, shareOfVoice: 20 },
      ],
      competitorCitations: { "rival.com": 6 },
    });

    expect(result.overall).toBe(42);
    expect(result.runId).toBe("run-1");
    expect(result.measuredAt).toBe("2026-09-01T00:00:00.000Z");
    expect(result.competitorCitations).toEqual({ "rival.com": 6 });
    expect(result.perEngine).toHaveLength(2);
    expect(result.perEngine[0]).toEqual({
      engine: "perplexity",
      ownCitations: 10,
      competitorCitations: 10,
      shareOfVoice: 50,
    });
    expect(result.perEngine[1]).toEqual({
      engine: "openai",
      ownCitations: 4,
      competitorCitations: 16,
      shareOfVoice: 20,
    });
  });

  it("treats a zero share of voice as zero competitor citations, not a division by zero", () => {
    const result = shareOfVoiceFrom("run-1", null, {
      perEngine: [{ engine: "perplexity", citations: 0, shareOfVoice: 0 }],
    });
    expect(result.perEngine[0]?.competitorCitations).toBe(0);
    expect(result.overall).toBeNull();
  });

  it("defaults to empty structures when the stored metrics carry none of the expected keys", () => {
    const result = shareOfVoiceFrom("run-1", null, {});
    expect(result.overall).toBeNull();
    expect(result.perEngine).toEqual([]);
    expect(result.competitorCitations).toEqual({});
  });
});
