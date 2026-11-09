/**
 * The recommendation rules, fingerprints and status machine (M13) — pure units.
 *
 * A rule that fires when it should not puts a wrong card in front of a customer, and a
 * fingerprint that drifts makes the same problem reappear every Monday as a new card. Both
 * failures destroy trust in the list faster than a missing recommendation would, so each
 * rule gets a test for firing *and* for staying quiet.
 */
import { describe, expect, it } from "vitest";
import {
  RULE_KEYS,
  RULE_THRESHOLDS_V1,
  evaluateRules,
  type PageRef,
  type SiteFindings,
} from "../../../src/domain/recommendations/rules.js";
import {
  fingerprintOf,
  leverageOf,
  rankRecommendations,
} from "../../../src/domain/recommendations/fingerprint.js";
import {
  CLIENT_SETTABLE,
  canClientTransition,
  statusAfterRecrawl,
  type RecStatus,
} from "../../../src/domain/recommendations/status.js";

const page = (index: number, wordCount = 500): PageRef => ({
  snapshotId: `snap-${index}`,
  url: `https://acme.com/p${index}`,
  wordCount,
});

/** A site with nothing wrong. Each test breaks exactly one thing. */
function healthy(overrides: Partial<SiteFindings> = {}): SiteFindings {
  return {
    crawlId: "crawl-1",
    pagesTotal: 10,
    blockedBots: [],
    llmsTxtPresent: true,
    llmsTxtValid: true,
    sitemapPresent: true,
    pagesWithStructuredData: 10,
    pagesMissingMetaDescription: [],
    thinPages: [],
    stalePages: [],
    orphanPages: [],
    missingTopics: [],
    unansweredQuestions: [],
    ...overrides,
  };
}

const keysOf = (findings: SiteFindings): readonly string[] =>
  evaluateRules(findings).map((rule) => rule.ruleKey);

describe("a healthy site", () => {
  it("produces no recommendations at all", () => {
    expect(evaluateRules(healthy())).toEqual([]);
  });
});

describe("blocked AI crawlers", () => {
  const blocked = healthy({
    blockedBots: [
      { bot: "GPTBot", blockedBy: "robots", fix: "User-agent: GPTBot\nAllow: /" },
      { bot: "PerplexityBot", blockedBy: "robots", fix: null },
    ],
  });

  it("fires as CRITICAL with maximum impact", () => {
    const [rule] = evaluateRules(blocked);
    expect(rule?.ruleKey).toBe("blocked-ai-crawlers");
    expect(rule?.priority).toBe("CRITICAL");
    expect(rule?.impact).toBe(5);
  });

  it("is the easiest fix on the list when robots.txt is the cause", () => {
    const [rule] = evaluateRules(blocked);
    expect(rule?.difficulty).toBe(1);
  });

  it("is harder when a CDN is doing the blocking", () => {
    const [rule] = evaluateRules(
      healthy({ blockedBots: [{ bot: "GPTBot", blockedBy: "cdn", fix: null }] }),
    );
    expect(rule?.difficulty).toBeGreaterThan(1);
  });

  it("names every blocked bot and carries the copy-paste fix", () => {
    const [rule] = evaluateRules(blocked);
    expect(rule?.body).toContain("GPTBot");
    expect(rule?.body).toContain("PerplexityBot");
    expect(rule?.evidence["fixes"]).toEqual(["User-agent: GPTBot\nAllow: /"]);
  });

  it("stays quiet when every bot is allowed", () => {
    expect(keysOf(healthy())).not.toContain("blocked-ai-crawlers");
  });
});

describe("llms.txt", () => {
  it("asks for one when it is missing", () => {
    expect(keysOf(healthy({ llmsTxtPresent: false, llmsTxtValid: null }))).toContain(
      "llms-txt-missing",
    );
  });

  it("distinguishes a broken one from a missing one", () => {
    const keys = keysOf(healthy({ llmsTxtPresent: true, llmsTxtValid: false }));
    expect(keys).toContain("llms-txt-invalid");
    expect(keys).not.toContain("llms-txt-missing");
  });

  it("stays quiet for a valid one", () => {
    expect(keysOf(healthy())).not.toContain("llms-txt-missing");
  });
});

describe("structured data", () => {
  it("fires HIGH when no page has any", () => {
    const rules = evaluateRules(healthy({ pagesWithStructuredData: 0 }));
    const rule = rules.find((item) => item.ruleKey === "structured-data-missing");
    expect(rule?.priority).toBe("HIGH");
    expect(rule?.body).toContain("10 of 10");
  });

  it("fires MEDIUM when some pages have it but too few", () => {
    const rule = evaluateRules(healthy({ pagesWithStructuredData: 3 })).find(
      (item) => item.ruleKey === "structured-data-missing",
    );
    expect(rule?.priority).toBe("MEDIUM");
  });

  it("stays quiet at the threshold", () => {
    const atThreshold = healthy({
      pagesWithStructuredData: RULE_THRESHOLDS_V1.structuredDataShare * 10,
    });
    expect(keysOf(atThreshold)).not.toContain("structured-data-missing");
  });

  it("does not divide by zero on a crawl with no pages", () => {
    expect(() =>
      evaluateRules(healthy({ pagesTotal: 0, pagesWithStructuredData: 0 })),
    ).not.toThrow();
    expect(keysOf(healthy({ pagesTotal: 0, pagesWithStructuredData: 0 }))).not.toContain(
      "structured-data-missing",
    );
  });
});

describe("content rules", () => {
  it("flags thin pages and names them", () => {
    const rule = evaluateRules(healthy({ thinPages: [page(1, 80), page(2, 40)] })).find(
      (item) => item.ruleKey === "thin-content",
    );
    expect(rule?.title).toContain("2 thin pages");
    expect(rule?.evidence["snapshotIds"]).toEqual(["snap-1", "snap-2"]);
  });

  it("escalates thin content when it is most of the site", () => {
    const many = Array.from({ length: 6 }, (_unused, index) => page(index, 50));
    const rule = evaluateRules(healthy({ pagesTotal: 10, thinPages: many })).find(
      (item) => item.ruleKey === "thin-content",
    );
    expect(rule?.priority).toBe("HIGH");
  });

  it("caps how many pages a card names", () => {
    const many = Array.from({ length: 40 }, (_unused, index) => page(index, 50));
    const rule = evaluateRules(healthy({ thinPages: many })).find(
      (item) => item.ruleKey === "thin-content",
    );
    expect((rule?.evidence["snapshotIds"] as string[]).length).toBe(
      RULE_THRESHOLDS_V1.evidencePages,
    );
    // …while still reporting the true total, so the card is not misleading.
    expect(rule?.evidence["total"]).toBe(40);
  });

  it("flags stale pages at LOW — real, but never the first thing to do", () => {
    const rule = evaluateRules(healthy({ stalePages: [page(1)] })).find(
      (item) => item.ruleKey === "stale-content",
    );
    expect(rule?.priority).toBe("LOW");
  });

  it("flags orphan pages", () => {
    expect(keysOf(healthy({ orphanPages: [page(3)] }))).toContain("orphan-pages");
  });

  it("flags missing descriptions", () => {
    expect(keysOf(healthy({ pagesMissingMetaDescription: [page(4)] }))).toContain(
      "meta-description-missing",
    );
  });
});

describe("analysis-derived rules", () => {
  it("raises the competitor's topics as one HIGH card", () => {
    const rule = evaluateRules(
      healthy({
        missingTopics: [
          { label: "Migration guides", gap: 80 },
          { label: "Security", gap: 60 },
        ],
      }),
    ).find((item) => item.ruleKey === "missing-topics");

    expect(rule?.priority).toBe("HIGH");
    expect(rule?.body).toContain("Migration guides");
    expect(rule?.evidence["topicLabels"]).toEqual(["Migration guides", "Security"]);
  });

  it("raises unanswered buyer questions with what was missing", () => {
    const rule = evaluateRules(
      healthy({
        unansweredQuestions: [
          { question: "What does it cost?", missingElement: "a price" },
          { question: "Is it SOC 2?", missingElement: null },
        ],
      }),
    ).find((item) => item.ruleKey === "unanswered-buyer-questions");

    expect(rule?.evidence["questions"]).toEqual(["What does it cost?", "Is it SOC 2?"]);
    expect(rule?.evidence["missingElements"]).toEqual(["a price", null]);
  });

  it("caps how many topics and questions one card carries", () => {
    const rules = evaluateRules(
      healthy({
        missingTopics: Array.from({ length: 20 }, (_unused, index) => ({
          label: `Topic ${index}`,
          gap: 70,
        })),
        unansweredQuestions: Array.from({ length: 20 }, (_unused, index) => ({
          question: `Q${index}`,
          missingElement: null,
        })),
      }),
    );
    const topics = rules.find((rule) => rule.ruleKey === "missing-topics");
    const questions = rules.find((rule) => rule.ruleKey === "unanswered-buyer-questions");

    expect((topics?.evidence["topicLabels"] as string[]).length).toBe(
      RULE_THRESHOLDS_V1.topicGapLimit,
    );
    expect((questions?.evidence["questions"] as string[]).length).toBe(
      RULE_THRESHOLDS_V1.questionLimit,
    );
  });
});

describe("the rule set as a whole", () => {
  it("fires everything on a thoroughly broken site", () => {
    const broken = healthy({
      blockedBots: [{ bot: "GPTBot", blockedBy: "robots", fix: null }],
      llmsTxtPresent: false,
      llmsTxtValid: null,
      sitemapPresent: false,
      pagesWithStructuredData: 0,
      pagesMissingMetaDescription: [page(1)],
      thinPages: [page(2, 50)],
      stalePages: [page(3)],
      orphanPages: [page(4)],
      missingTopics: [{ label: "Pricing", gap: 70 }],
      unansweredQuestions: [{ question: "What does it cost?", missingElement: "a price" }],
    });

    const keys = keysOf(broken);
    expect(keys).toHaveLength(10);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only ever emits keys the published set declares", () => {
    const broken = healthy({
      blockedBots: [{ bot: "GPTBot", blockedBy: "robots", fix: null }],
      llmsTxtPresent: false,
      sitemapPresent: false,
      pagesWithStructuredData: 0,
      thinPages: [page(1, 10)],
      stalePages: [page(2)],
      orphanPages: [page(3)],
      pagesMissingMetaDescription: [page(4)],
      missingTopics: [{ label: "Pricing", gap: 70 }],
      unansweredQuestions: [{ question: "Cost?", missingElement: null }],
    });
    for (const key of keysOf(broken)) expect(RULE_KEYS).toContain(key);
  });

  it("is deterministic — the same findings give the same list in the same order", () => {
    const findings = healthy({ thinPages: [page(1, 50)], orphanPages: [page(2)] });
    expect(evaluateRules(findings)).toEqual(evaluateRules(findings));
  });

  it("keeps every impact and difficulty inside the schema's 1–5 range", () => {
    const broken = healthy({
      blockedBots: [{ bot: "GPTBot", blockedBy: "cdn", fix: null }],
      llmsTxtPresent: false,
      sitemapPresent: false,
      pagesWithStructuredData: 0,
      thinPages: [page(1, 10)],
      stalePages: [page(2)],
      orphanPages: [page(3)],
      pagesMissingMetaDescription: [page(4)],
      missingTopics: [{ label: "Pricing", gap: 70 }],
      unansweredQuestions: [{ question: "Cost?", missingElement: null }],
    });
    for (const rule of evaluateRules(broken)) {
      expect(rule.impact).toBeGreaterThanOrEqual(1);
      expect(rule.impact).toBeLessThanOrEqual(5);
      expect(rule.difficulty).toBeGreaterThanOrEqual(1);
      expect(rule.difficulty).toBeLessThanOrEqual(5);
    }
  });
});

describe("fingerprints", () => {
  it("keys a rule finding on its rule, not its wording", () => {
    const first = fingerprintOf({ source: "RULE", ruleKey: "thin-content", title: "Expand 3 thin pages" });
    const later = fingerprintOf({ source: "RULE", ruleKey: "thin-content", title: "Expand 7 thin pages" });
    expect(first).toBe(later);
  });

  it("separates different rules", () => {
    expect(fingerprintOf({ source: "RULE", ruleKey: "thin-content", title: "a" })).not.toBe(
      fingerprintOf({ source: "RULE", ruleKey: "orphan-pages", title: "a" }),
    );
  });

  it("keys a model suggestion on its hint when it gave one", () => {
    const a = fingerprintOf({ source: "AI", ruleKey: null, ruleHint: "content-depth", title: "Write more" });
    const b = fingerprintOf({ source: "AI", ruleKey: null, ruleHint: "content-depth", title: "Write deeper pages" });
    expect(a).toBe(b);
  });

  it("falls back to the title when it did not", () => {
    const a = fingerprintOf({ source: "AI", ruleKey: null, ruleHint: null, title: "Write a pricing page" });
    const b = fingerprintOf({ source: "AI", ruleKey: null, ruleHint: null, title: "Write a Pricing Page!" });
    // Slugged, so punctuation and case cannot fork a card.
    expect(a).toBe(b);
  });

  it("never collides a rule with a model suggestion", () => {
    expect(fingerprintOf({ source: "RULE", ruleKey: "thin-content", title: "x" })).not.toBe(
      fingerprintOf({ source: "AI", ruleKey: null, ruleHint: "thin-content", title: "x" }),
    );
  });
});

describe("ranking", () => {
  const card = (overrides: Partial<Parameters<typeof leverageOf>[0] & { priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; source: "RULE" | "AI"; title: string }>) => ({
    impact: 3,
    difficulty: 3,
    priority: "MEDIUM" as const,
    source: "RULE" as const,
    title: "card",
    ...overrides,
  });

  it("is impact divided by difficulty", () => {
    expect(leverageOf({ impact: 5, difficulty: 1 })).toBe(5);
    expect(leverageOf({ impact: 2, difficulty: 4 })).toBe(0.5);
  });

  it("never divides by zero", () => {
    expect(Number.isFinite(leverageOf({ impact: 5, difficulty: 0 }))).toBe(true);
  });

  it("puts priority first — a blocked crawler makes everything else moot", () => {
    const ranked = rankRecommendations([
      card({ priority: "MEDIUM", impact: 5, difficulty: 1, title: "high leverage" }),
      card({ priority: "CRITICAL", impact: 5, difficulty: 5, title: "critical" }),
    ]);
    expect(ranked[0]?.title).toBe("critical");
  });

  it("orders by leverage within a priority", () => {
    const ranked = rankRecommendations([
      card({ impact: 2, difficulty: 4, title: "expensive" }),
      card({ impact: 5, difficulty: 1, title: "cheap win" }),
    ]);
    expect(ranked.map((row) => row.title)).toEqual(["cheap win", "expensive"]);
  });

  it("breaks a tie toward the rule, because a rule is a fact", () => {
    const ranked = rankRecommendations([
      card({ source: "AI", title: "suggestion" }),
      card({ source: "RULE", title: "finding" }),
    ]);
    expect(ranked[0]?.source).toBe("RULE");
  });

  it("is stable — the same cards rank the same way every time", () => {
    const cards = [card({ title: "b" }), card({ title: "a" }), card({ title: "c" })];
    expect(rankRecommendations(cards)).toEqual(rankRecommendations(cards));
  });
});

describe("status transitions", () => {
  it("lets a client open, complete and dismiss", () => {
    expect(canClientTransition("OPEN", "DONE")).toBeNull();
    expect(canClientTransition("OPEN", "DISMISSED")).toBeNull();
    expect(canClientTransition("DONE", "OPEN")).toBeNull();
    expect(canClientTransition("DISMISSED", "OPEN")).toBeNull();
  });

  it("refuses the two statuses the pipeline owns", () => {
    for (const status of ["VALIDATED", "REGRESSED"] as const) {
      const rejection = canClientTransition("OPEN", status);
      expect(rejection?.reason).toBe("not_client_settable");
      expect(rejection?.detail).toContain("pipeline");
    }
    expect(CLIENT_SETTABLE).toEqual(["OPEN", "DONE", "DISMISSED"]);
  });

  it("refuses a move that skips the open state", () => {
    expect(canClientTransition("DONE", "DISMISSED")?.reason).toBe("illegal_transition");
    expect(canClientTransition("DISMISSED", "DONE")?.reason).toBe("illegal_transition");
  });

  it("lets a confirmed-fixed card be reopened but not re-completed", () => {
    expect(canClientTransition("VALIDATED", "OPEN")).toBeNull();
    expect(canClientTransition("VALIDATED", "DONE")?.reason).toBe("illegal_transition");
  });

  it("treats a no-op as allowed rather than as an error", () => {
    for (const status of CLIENT_SETTABLE) {
      expect(canClientTransition(status as RecStatus, status as RecStatus)).toBeNull();
    }
  });
});

describe("what a later crawl does", () => {
  it("confirms a fix the user claimed", () => {
    expect(statusAfterRecrawl("DONE", false)).toBe("VALIDATED");
  });

  it("calls out a fix that did not hold", () => {
    expect(statusAfterRecrawl("DONE", true)).toBe("REGRESSED");
    expect(statusAfterRecrawl("VALIDATED", true)).toBe("REGRESSED");
  });

  it("leaves an open issue open", () => {
    expect(statusAfterRecrawl("OPEN", true)).toBeNull();
  });

  it("does not overturn a dismissal", () => {
    expect(statusAfterRecrawl("DISMISSED", false)).toBeNull();
    expect(statusAfterRecrawl("DISMISSED", true)).toBeNull();
  });

  it("does not validate an issue the user never claimed to fix", () => {
    // Gone, but they never said they fixed it — it may simply not have been crawled.
    expect(statusAfterRecrawl("OPEN", false)).toBeNull();
  });
});
