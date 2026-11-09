/**
 * The scoring maths (M12), against hand-computed fixtures.
 *
 * Every expected number is worked out from the published weights rather than copied from a
 * run. These are the numbers customers see and dispute, so a change to any weight must
 * fail loudly here rather than quietly shift every score in the product.
 */
import { describe, expect, it } from "vitest";
import {
  DECISION_INTENT_MULTIPLIER,
  QUALITY_WEIGHTS_V1,
  SCORING_V1,
  TECHNICAL_WEIGHTS_V1,
  TRUST_WEIGHTS_V1,
} from "../../../src/config/scoring/v1.js";
import {
  computeComposite,
  toComponentColumns,
  toComponentsPayload,
  SCORE_COMPONENTS,
  type ComponentInputs,
} from "../../../src/domain/scoring/composite.js";
import {
  contentQualityScore,
  pageQualityScore,
  technicalScore,
  topicCoverageScore,
  trustScore,
} from "../../../src/domain/scoring/components.js";

/** All six components present at the same value, so weighting is visible in isolation. */
function allAt(value: number): ComponentInputs {
  return Object.fromEntries(
    SCORE_COMPONENTS.map((component) => [component, { value }]),
  ) as ComponentInputs;
}

function inputs(overrides: Partial<ComponentInputs>): ComponentInputs {
  return { ...allAt(50), ...overrides };
}

describe("computeComposite", () => {
  it("is the weighted mean when every component is present", () => {
    const result = computeComposite(allAt(80), SCORING_V1);
    expect(result.composite).toBe(80);
    expect(result.totalWeight).toBeCloseTo(1, 10);
    expect(result.published).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it("weights the components as the pipeline doc publishes them", () => {
    // citation 100 at 0.35, everything else 0 → 35.
    const result = computeComposite(
      { ...allAt(0), citation: { value: 100 } },
      SCORING_V1,
    );
    expect(result.composite).toBe(35);
  });

  it("renormalizes rather than scoring an absent component zero", () => {
    // Without citation the surviving weight is 0.65; every survivor is 80, so 80 stands.
    const result = computeComposite(
      { ...allAt(80), citation: { value: null, reason: "unavailable_yet" } },
      SCORING_V1,
    );
    const withCitation = computeComposite(allAt(80), SCORING_V1);

    expect(result.composite).toBe(80);
    expect(result.composite).toBe(withCitation.composite);
    expect(result.totalWeight).toBeCloseTo(0.65, 10);
  });

  it("computes the documented first-crawl case exactly", () => {
    // No prompt run yet, so citation is absent. Remaining: retrievability 0.20 at 60,
    // contentQuality 0.15 at 70, topicCoverage 0.15 at 40, technical 0.10 at 90,
    // trust 0.05 at 50 → (12 + 10.5 + 6 + 9 + 2.5) / 0.65 = 40 / 0.65 = 61.54 → 62.
    const result = computeComposite(
      {
        citation: { value: null, reason: "unavailable_yet" },
        retrievability: { value: 60 },
        contentQuality: { value: 70 },
        topicCoverage: { value: 40 },
        technical: { value: 90 },
        trust: { value: 50 },
      },
      SCORING_V1,
    );

    expect(result.composite).toBe(62);
    expect(result.published).toBe(true);
  });

  it("publishes nothing below the floor", () => {
    // Only technical (0.10) and trust (0.05) — 0.15 of the evidence.
    const result = computeComposite(
      {
        citation: { value: null, reason: "unavailable_yet" },
        retrievability: { value: null, reason: "failed" },
        contentQuality: { value: null, reason: "failed" },
        topicCoverage: { value: null, reason: "failed" },
        technical: { value: 90 },
        trust: { value: 100 },
      },
      SCORING_V1,
    );

    expect(result.published).toBe(false);
    expect(result.composite).toBeNull();
    expect(result.totalWeight).toBeCloseTo(0.15, 10);
  });

  it("publishes exactly at the floor", () => {
    // retrievability 0.20 + contentQuality 0.15 + technical 0.10 + trust 0.05 = 0.50.
    const result = computeComposite(
      {
        citation: { value: null, reason: "unavailable_yet" },
        retrievability: { value: 60 },
        contentQuality: { value: 60 },
        topicCoverage: { value: null, reason: "failed" },
        technical: { value: 60 },
        trust: { value: 60 },
      },
      SCORING_V1,
    );

    // Exactly 0.50 in decimal is 0.49999999999999994 in binary; the floor comparison
    // carries an epsilon so the boundary behaves the way the doc says it does.
    expect(result.totalWeight).toBeCloseTo(0.5, 10);
    expect(result.totalWeight).toBeLessThan(0.5);
    expect(result.published).toBe(true);
    expect(result.composite).toBe(60);
  });

  it("marks the score degraded only for a failure, never for a component that has not run", () => {
    const notYet = computeComposite(
      inputs({ citation: { value: null, reason: "unavailable_yet" } }),
      SCORING_V1,
    );
    const failed = computeComposite(
      inputs({ retrievability: { value: null, reason: "failed" } }),
      SCORING_V1,
    );

    expect(notYet.degraded).toBe(false);
    expect(failed.degraded).toBe(true);
  });

  it("defaults a missing reason to unavailable_yet rather than calling it a failure", () => {
    const result = computeComposite(inputs({ citation: { value: null } }), SCORING_V1);
    expect(result.degraded).toBe(false);
    expect(result.components.find((row) => row.component === "citation")?.reason).toBe(
      "unavailable_yet",
    );
  });

  it("clamps a component outside its range instead of letting it move the composite", () => {
    // A prompt-injected 500 must not be able to lift the score (AI-Pipeline §6.3).
    const result = computeComposite(allAt(100), SCORING_V1);
    const injected = computeComposite(
      { ...allAt(100), contentQuality: { value: 500 } },
      SCORING_V1,
    );
    expect(injected.composite).toBe(result.composite);
    expect(injected.composite).toBe(100);
  });

  it("clamps a negative component to zero", () => {
    const result = computeComposite({ ...allAt(0), citation: { value: -50 } }, SCORING_V1);
    expect(result.composite).toBe(0);
  });

  it("is a pure function — identical inputs give an identical result", () => {
    const first = computeComposite(allAt(73), SCORING_V1);
    const second = computeComposite(allAt(73), SCORING_V1);
    expect(first).toEqual(second);
  });

  it("publishes nothing when every component is absent", () => {
    const result = computeComposite(
      Object.fromEntries(
        SCORE_COMPONENTS.map((component) => [component, { value: null }]),
      ) as ComponentInputs,
      SCORING_V1,
    );
    expect(result.composite).toBeNull();
    expect(result.totalWeight).toBe(0);
  });
});

describe("the breakdown payload", () => {
  const result = computeComposite(
    {
      citation: { value: null, reason: "unavailable_yet" },
      retrievability: { value: 60, evidence: { crawlId: "c1" } },
      contentQuality: { value: 70 },
      topicCoverage: { value: 40 },
      technical: { value: 90 },
      trust: { value: 50 },
    },
    SCORING_V1,
  );

  it("records every component, present or not", () => {
    const payload = toComponentsPayload(result);
    const rows = payload["components"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(SCORE_COMPONENTS.length);
    expect(rows.map((row) => row["component"])).toEqual([...SCORE_COMPONENTS]);
  });

  it("carries the base weight, the renormalized weight, and the absence reason", () => {
    const rows = (toComponentsPayload(result)["components"] as Array<Record<string, unknown>>);
    const retrievability = rows.find((row) => row["component"] === "retrievability");
    const citation = rows.find((row) => row["component"] === "citation");

    expect(retrievability).toMatchObject({ value: 60, weight: 0.2, reason: null });
    // 0.20 of the surviving 0.65.
    expect(retrievability?.["effectiveWeight"]).toBeCloseTo(0.3077, 4);
    expect(citation).toMatchObject({ value: null, effectiveWeight: 0, reason: "unavailable_yet" });
  });

  it("effective weights sum to one across the present components", () => {
    const rows = toComponentsPayload(result)["components"] as Array<{ effectiveWeight: number }>;
    const total = rows.reduce((sum, row) => sum + row.effectiveWeight, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it("keeps the evidence a component supplied, so the drawer can link to it", () => {
    const rows = toComponentsPayload(result)["components"] as Array<Record<string, unknown>>;
    expect(rows.find((row) => row["component"] === "retrievability")?.["evidence"]).toEqual({
      crawlId: "c1",
    });
  });

  it("maps cleanly onto the score row's per-component columns", () => {
    expect(toComponentColumns(result)).toEqual({
      citation: null,
      retrievability: 60,
      contentQuality: 70,
      topicCoverage: 40,
      technical: 90,
      trust: 50,
    });
  });
});

describe("pageQualityScore", () => {
  it("applies the published rubric weights", () => {
    // 0.30·80 + 0.20·60 + 0.20·40 + 0.10·100 + 0.20·50 = 24 + 12 + 8 + 10 + 10 = 64.
    expect(
      pageQualityScore(
        { depth: 80, clarity: 60, evidence: 40, freshness: 100, aiReadability: 50 },
        QUALITY_WEIGHTS_V1,
      ),
    ).toBe(64);
  });

  it("clamps a dimension a page tried to inflate", () => {
    expect(
      pageQualityScore(
        { depth: 999, clarity: 100, evidence: 100, freshness: 100, aiReadability: 100 },
        QUALITY_WEIGHTS_V1,
      ),
    ).toBe(100);
  });
});

describe("contentQualityScore", () => {
  it("is the mean of the pages that scored", () => {
    const result = contentQualityScore([60, 80, 70, 90, 50, 70], 6, 0.6);
    expect(result.score).toBe(70);
    expect(result.pagesScored).toBe(6);
  });

  it("is null when too few of the sample scored", () => {
    // Four of thirty is 13%, well under the 60% the pipeline doc requires.
    const result = contentQualityScore([60, 80, 70, 90], 30, 0.6);
    expect(result.score).toBeNull();
    expect(result.scoredShare).toBeCloseTo(4 / 30, 10);
  });

  it("accepts exactly the threshold", () => {
    const result = contentQualityScore(Array.from({ length: 6 }, () => 70), 10, 0.6);
    expect(result.score).toBe(70);
  });

  it("is null when nothing scored at all", () => {
    expect(contentQualityScore([], 10, 0.6).score).toBeNull();
  });
});

describe("topicCoverageScore", () => {
  it("is a plain mean when no topic carries an intent", () => {
    expect(
      topicCoverageScore(
        [
          { coverageScore: 80, buyerIntent: null },
          { coverageScore: 40, buyerIntent: null },
        ],
        DECISION_INTENT_MULTIPLIER,
      ),
    ).toBe(60);
  });

  it("counts a decision-stage topic twice", () => {
    // (80·1 + 40·2) / 3 = 160/3 = 53.33 → 53.
    expect(
      topicCoverageScore(
        [
          { coverageScore: 80, buyerIntent: "awareness" },
          { coverageScore: 40, buyerIntent: "decision" },
        ],
        DECISION_INTENT_MULTIPLIER,
      ),
    ).toBe(53);
  });

  it("treats a null intent as the base weight, never as a guess", () => {
    const withNull = topicCoverageScore(
      [
        { coverageScore: 80, buyerIntent: null },
        { coverageScore: 40, buyerIntent: "decision" },
      ],
      DECISION_INTENT_MULTIPLIER,
    );
    const withAwareness = topicCoverageScore(
      [
        { coverageScore: 80, buyerIntent: "awareness" },
        { coverageScore: 40, buyerIntent: "decision" },
      ],
      DECISION_INTENT_MULTIPLIER,
    );
    expect(withNull).toBe(withAwareness);
  });

  it("is null with no topics — unmeasured, not zero", () => {
    expect(topicCoverageScore([], DECISION_INTENT_MULTIPLIER)).toBeNull();
  });
});

describe("technicalScore", () => {
  const perfect = {
    botAccessShare: 100,
    pagesWithStructuredData: 10,
    pagesTotal: 10,
    llmsTxtPresent: true,
    llmsTxtValid: true,
    sitemapPresent: true,
    pagesWithCanonical: 10,
    pagesWithMetaDescription: 10,
    pagesWithTitle: 10,
  };

  it("scores 100 when everything is in place", () => {
    expect(technicalScore(perfect, TECHNICAL_WEIGHTS_V1).score).toBe(100);
  });

  it("scores 0 when nothing is", () => {
    const result = technicalScore(
      {
        botAccessShare: 0,
        pagesWithStructuredData: 0,
        pagesTotal: 10,
        llmsTxtPresent: false,
        llmsTxtValid: null,
        sitemapPresent: false,
        pagesWithCanonical: 0,
        pagesWithMetaDescription: 0,
        pagesWithTitle: 0,
      },
      TECHNICAL_WEIGHTS_V1,
    );
    expect(result.score).toBe(0);
  });

  it("makes blocked bots the dominant penalty", () => {
    // Bot access is half the component: losing it alone costs fifty points.
    const blocked = technicalScore({ ...perfect, botAccessShare: 0 }, TECHNICAL_WEIGHTS_V1);
    expect(blocked.score).toBe(50);
  });

  it("gives nothing for an llms.txt that exists but is invalid", () => {
    const invalid = technicalScore(
      { ...perfect, llmsTxtPresent: true, llmsTxtValid: false },
      TECHNICAL_WEIGHTS_V1,
    );
    expect(invalid.score).toBe(90);
    expect(invalid.parts.llmsTxt).toBe(0);
  });

  it("averages the three meta-hygiene signals", () => {
    // Canonicals on half the pages, everything else present: hygiene = (0.5+1+1)/3 = 0.833
    // → 8.33 of the 10 available points → 98.33 → 98.
    const partial = technicalScore(
      { ...perfect, pagesWithCanonical: 5 },
      TECHNICAL_WEIGHTS_V1,
    );
    expect(partial.score).toBe(98);
  });

  it("does not divide by zero on a crawl with no readable pages", () => {
    const empty = technicalScore(
      { ...perfect, pagesTotal: 0, pagesWithStructuredData: 0, pagesWithCanonical: 0, pagesWithMetaDescription: 0, pagesWithTitle: 0 },
      TECHNICAL_WEIGHTS_V1,
    );
    // Bot access, llms.txt and the sitemap still count; the page-derived parts are zero.
    expect(Number.isFinite(empty.score)).toBe(true);
    expect(empty.score).toBe(70);
  });
});

describe("trustScore", () => {
  const strong = {
    contentPages: 10,
    pagesWithAuthor: 10,
    hasAboutPage: true,
    hasContactPage: true,
    pagesWithOutboundCitations: 10,
    httpsValid: true,
    hasDatedPolicyPage: true,
  };

  it("scores 100 with every signal present", () => {
    expect(trustScore(strong, TRUST_WEIGHTS_V1).score).toBe(100);
  });

  it("scores 0 with none", () => {
    const result = trustScore(
      {
        contentPages: 10,
        pagesWithAuthor: 0,
        hasAboutPage: false,
        hasContactPage: false,
        pagesWithOutboundCitations: 0,
        httpsValid: false,
        hasDatedPolicyPage: false,
      },
      TRUST_WEIGHTS_V1,
    );
    expect(result.score).toBe(0);
  });

  it("requires citations on 30% of content pages before crediting them", () => {
    const below = trustScore({ ...strong, pagesWithOutboundCitations: 2 }, TRUST_WEIGHTS_V1);
    const at = trustScore({ ...strong, pagesWithOutboundCitations: 3 }, TRUST_WEIGHTS_V1);

    expect(below.parts.outboundCitations).toBe(false);
    expect(at.parts.outboundCitations).toBe(true);
    expect(at.score - below.score).toBe(TRUST_WEIGHTS_V1.outboundCitations);
  });

  it("does not credit author bios on a site with no content pages", () => {
    const result = trustScore({ ...strong, contentPages: 0, pagesWithAuthor: 0 }, TRUST_WEIGHTS_V1);
    expect(result.parts.authorBios).toBe(false);
  });

  it("reports which signals were found, for the drawer", () => {
    const result = trustScore({ ...strong, hasAboutPage: false }, TRUST_WEIGHTS_V1);
    expect(result.parts).toMatchObject({ aboutPage: false, contactPage: true, https: true });
    expect(result.score).toBe(100 - TRUST_WEIGHTS_V1.aboutPage);
  });
});

describe("the v1 configuration", () => {
  it("uses exactly the weights the pipeline doc publishes", () => {
    expect(SCORING_V1.weights).toEqual({
      citation: 0.35,
      retrievability: 0.2,
      contentQuality: 0.15,
      topicCoverage: 0.15,
      technical: 0.1,
      trust: 0.05,
    });
    expect(SCORING_V1.publicationFloor).toBe(0.5);
    expect(SCORING_V1.version).toBe("scoring.v1");
  });

  it("has base weights summing to one, so a perfect site scores exactly 100", () => {
    const total = Object.values(SCORING_V1.weights).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("has rubric weights summing to one", () => {
    const total = Object.values(QUALITY_WEIGHTS_V1).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("has technical sub-weights summing to one and trust points summing to 100", () => {
    expect(
      Object.values(TECHNICAL_WEIGHTS_V1).reduce((sum, weight) => sum + weight, 0),
    ).toBeCloseTo(1, 10);
    expect(Object.values(TRUST_WEIGHTS_V1).reduce((sum, points) => sum + points, 0)).toBe(100);
  });
});
