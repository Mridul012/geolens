/**
 * Topic coverage maths (AI-Pipeline §3.4) against hand-computed fixtures.
 *
 * Every expected number below is worked out by hand from the published formula rather than
 * copied from a run, so a change to the weights fails here loudly instead of quietly
 * shifting every customer's score.
 */
import { describe, expect, it } from "vitest";
import { COVERAGE_V1 } from "../../../src/config/scoring/coverage.v1.js";
import {
  compareCoverage,
  cosineSimilarity,
  coverageScore,
  depthFactor,
  isMissingTopic,
  normalizedTopSimilarity,
  scoreTopics,
} from "../../../src/domain/topics/coverage.js";

const T = COVERAGE_V1;

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it("ignores magnitude — direction is the whole signal", () => {
    expect(cosineSimilarity([1, 1], [10, 10])).toBeCloseTo(1, 10);
  });

  it("is -1 for opposed vectors", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it("returns 0 rather than NaN for a zero vector or a length mismatch", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("normalizedTopSimilarity", () => {
  it("is 0 at or below the floor", () => {
    expect(normalizedTopSimilarity(0.55, T)).toBe(0);
    expect(normalizedTopSimilarity(0.1, T)).toBe(0);
    expect(normalizedTopSimilarity(-0.4, T)).toBe(0);
  });

  it("saturates at 1 once the ramp is exhausted", () => {
    // floor 0.55 + range 0.30 = 0.85. Exactly at the top of the ramp IEEE-754 lands on
    // 0.9999999999999998, which `Math.round(100 · …)` erases — so this is checked to
    // tolerance rather than pretending binary floats are decimals.
    expect(normalizedTopSimilarity(0.85, T)).toBeCloseTo(1, 12);
    expect(normalizedTopSimilarity(0.99, T)).toBe(1);
  });

  it("is linear in between", () => {
    // (0.70 - 0.55) / 0.30 = 0.5
    expect(normalizedTopSimilarity(0.7, T)).toBeCloseTo(0.5, 10);
  });

  it("treats a topic with no matching chunk at all as 0, not as a negative", () => {
    expect(normalizedTopSimilarity(null, T)).toBe(0);
  });
});

describe("depthFactor", () => {
  it("saturates at the configured chunk count", () => {
    expect(depthFactor(0, T)).toBe(0);
    expect(depthFactor(1, T)).toBeCloseTo(0.2, 10);
    expect(depthFactor(5, T)).toBe(1);
    expect(depthFactor(50, T)).toBe(1);
  });
});

describe("coverageScore", () => {
  it("scores 0 when nothing in the corpus is about the topic", () => {
    expect(coverageScore({ maxSimilarity: null, depthChunks: 0 }, T)).toBe(0);
    expect(coverageScore({ maxSimilarity: 0.2, depthChunks: 0 }, T)).toBe(0);
  });

  it("scores 100 only when the best match is excellent AND there is depth", () => {
    expect(coverageScore({ maxSimilarity: 0.9, depthChunks: 5 }, T)).toBe(100);
  });

  it("caps one excellent page well below 100 — a mention is not coverage", () => {
    // quality 1.0 × 0.6 + depth 0.2 × 0.4 = 0.68
    expect(coverageScore({ maxSimilarity: 0.95, depthChunks: 1 }, T)).toBe(68);
  });

  it("caps twenty weak matches well below 100 — volume is not coverage either", () => {
    // quality 0 × 0.6 + depth 1.0 × 0.4 = 0.40
    expect(coverageScore({ maxSimilarity: 0.5, depthChunks: 20 }, T)).toBe(40);
  });

  it("matches the published formula on a middling case", () => {
    // quality (0.73-0.55)/0.30 = 0.6 → 0.36; depth 3/5 = 0.6 → 0.24; total 0.60
    expect(coverageScore({ maxSimilarity: 0.73, depthChunks: 3 }, T)).toBe(60);
  });

  it("never exceeds 100 however generous the inputs", () => {
    expect(coverageScore({ maxSimilarity: 1, depthChunks: 10_000 }, T)).toBe(100);
  });
});

describe("scoreTopics", () => {
  it("scores every topic it is given and trims evidence to the configured count", () => {
    const scored = scoreTopics(
      [
        {
          topicId: "a",
          maxSimilarity: 0.9,
          depthChunks: 8,
          evidenceChunkIds: ["1", "2", "3", "4", "5", "6", "7"],
        },
        { topicId: "b", maxSimilarity: null, depthChunks: 0, evidenceChunkIds: [] },
      ],
      T,
    );

    expect(scored).toHaveLength(2);
    expect(scored[0]?.coverageScore).toBe(100);
    expect(scored[0]?.evidenceChunkIds).toHaveLength(T.evidenceChunks);
    expect(scored[1]?.coverageScore).toBe(0);
    expect(scored[1]?.evidenceChunkIds).toEqual([]);
  });
});

describe("isMissingTopic", () => {
  it("is true when the competitor is strong and we are effectively absent", () => {
    expect(isMissingTopic(0, 80, T)).toBe(true);
    expect(isMissingTopic(25, 60, T)).toBe(true);
    expect(isMissingTopic(null, 60, T)).toBe(true);
  });

  it("is false when the competitor is merely ahead", () => {
    // A near-tie is not an actionable finding, however large the raw gap feels.
    expect(isMissingTopic(26, 60, T)).toBe(false);
    expect(isMissingTopic(0, 59, T)).toBe(false);
  });

  it("is false when there is no competitor data at all", () => {
    expect(isMissingTopic(0, null, T)).toBe(false);
  });
});

describe("compareCoverage", () => {
  const rows = [
    { topicId: "a", label: "Pricing", ownCoverage: 80, ownDepth: 9, competitorCoverage: 85 },
    { topicId: "b", label: "Security", ownCoverage: 5, ownDepth: 0, competitorCoverage: 90 },
    { topicId: "c", label: "Migration", ownCoverage: 10, ownDepth: 1, competitorCoverage: 70 },
    { topicId: "d", label: "Careers", ownCoverage: 40, ownDepth: 4, competitorCoverage: null },
  ];

  it("computes the gap as competitor minus own", () => {
    const compared = compareCoverage(rows, T);
    const pricing = compared.find((row) => row.topicId === "a");
    expect(pricing?.gap).toBe(5);
    expect(pricing?.missing).toBe(false);
  });

  it("ranks missing topics first, then by gap descending", () => {
    expect(compareCoverage(rows, T).map((row) => row.topicId)).toEqual(["b", "c", "a", "d"]);
  });

  it("leaves the gap null when the competitor has no coverage row", () => {
    const careers = compareCoverage(rows, T).find((row) => row.topicId === "d");
    expect(careers?.gap).toBeNull();
    expect(careers?.missing).toBe(false);
  });

  it("treats absent own coverage as zero for the gap, but reports it as null", () => {
    const compared = compareCoverage(
      [{ topicId: "x", label: "New", ownCoverage: null, ownDepth: null, competitorCoverage: 70 }],
      T,
    );
    expect(compared[0]?.ownCoverage).toBeNull();
    expect(compared[0]?.gap).toBe(70);
  });

  it("breaks ties on label so the same data always renders in the same order", () => {
    const tied = compareCoverage(
      [
        { topicId: "z", label: "Zebra", ownCoverage: 10, ownDepth: 1, competitorCoverage: 30 },
        { topicId: "a", label: "Apple", ownCoverage: 10, ownDepth: 1, competitorCoverage: 30 },
      ],
      T,
    );
    expect(tied.map((row) => row.label)).toEqual(["Apple", "Zebra"]);
  });

  it("returns a row per topic, including ones nobody covers", () => {
    const compared = compareCoverage(
      [{ topicId: "q", label: "Quiet", ownCoverage: null, ownDepth: null, competitorCoverage: null }],
      T,
    );
    expect(compared).toHaveLength(1);
    expect(compared[0]).toMatchObject({ ownCoverage: null, competitorCoverage: null, gap: null });
  });
});

describe("the v1 thresholds", () => {
  it("are exactly the numbers the pipeline doc publishes", () => {
    expect(COVERAGE_V1).toMatchObject({
      version: "coverage.v1",
      matchThreshold: 0.62,
      simFloor: 0.55,
      simRange: 0.3,
      depthSaturation: 5,
      qualityWeight: 0.6,
      depthWeight: 0.4,
      competitorStrongAtLeast: 60,
      ownAbsentAtMost: 25,
    });
  });

  it("weights sum to one, so a perfect topic scores exactly 100", () => {
    expect(COVERAGE_V1.qualityWeight + COVERAGE_V1.depthWeight).toBeCloseTo(1, 10);
  });
});
