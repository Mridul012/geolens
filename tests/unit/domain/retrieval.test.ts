/**
 * RRF and the retrievability metrics (M11), against hand-computed fixtures.
 *
 * Every expected number below is worked out from the published formula rather than copied
 * from a run: `score(d) = Σ 1/(k + rank)` with k = 60, and
 * `hitRate = (fully + 0.5·partially) / judged`.
 */
import { describe, expect, it } from "vitest";
import { RETRIEVABILITY_V1 } from "../../../src/config/scoring/retrievability.v1.js";
import { fuseTop, reciprocalRankFusion } from "../../../src/domain/retrieval/rrf.js";
import {
  summarise,
  unansweredQuestions,
  type QuestionOutcome,
} from "../../../src/domain/retrieval/metrics.js";

const K = RETRIEVABILITY_V1.rrfK;

function outcome(overrides: Partial<QuestionOutcome> = {}): QuestionOutcome {
  return {
    question: "What does it cost?",
    topicLabel: "Pricing",
    answered: "fully",
    confidence: 90,
    missingElement: null,
    chunkIds: ["1"],
    ...overrides,
  };
}

describe("reciprocalRankFusion", () => {
  it("scores a single arm as 1/(k + rank)", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"]], K);

    expect(fused.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 12);
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 12);
    expect(fused[2]?.score).toBeCloseTo(1 / 63, 12);
  });

  it("sums the contributions of every arm that returned a document", () => {
    // "b" is 2nd in one arm and 1st in the other: 1/62 + 1/61.
    const fused = reciprocalRankFusion(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      K,
    );
    const b = fused.find((row) => row.id === "b");
    expect(b?.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(b?.ranks).toEqual([2, 1]);
  });

  it("puts a document both arms like above one a single arm ranks first", () => {
    // This is the whole reason a hybrid retriever fuses instead of concatenating.
    const fused = reciprocalRankFusion(
      [
        ["solo", "both"],
        ["other", "both"],
      ],
      K,
    );
    expect(fused[0]?.id).toBe("both");
    // 1/62 + 1/62 = 0.03226 beats solo's 1/61 = 0.01639.
    expect(fused[0]?.score).toBeCloseTo(2 / 62, 12);
  });

  it("damps the top of each list, so rank 1 barely beats rank 2", () => {
    const fused = reciprocalRankFusion([["first", "second"]], K);
    const ratio = (fused[0]?.score ?? 0) / (fused[1]?.score ?? 1);
    expect(ratio).toBeLessThan(1.02);
  });

  it("breaks ties on id, so the same inputs always fuse to the same order", () => {
    const arms = [
      ["z", "a"],
      ["a", "z"],
    ];
    // Both documents score 1/61 + 1/62 exactly.
    expect(reciprocalRankFusion(arms, K).map((row) => row.id)).toEqual(["a", "z"]);
    expect(reciprocalRankFusion(arms, K)).toEqual(reciprocalRankFusion(arms, K));
  });

  it("handles an arm that returned nothing as an arm with no opinion", () => {
    const fused = reciprocalRankFusion([["a", "b"], []], K);
    expect(fused.map((row) => row.id)).toEqual(["a", "b"]);
    expect(fused[0]?.ranks).toEqual([1]);
  });

  it("returns nothing when no arm returned anything", () => {
    expect(reciprocalRankFusion([[], []], K)).toEqual([]);
    expect(reciprocalRankFusion([], K)).toEqual([]);
  });

  it("is unaffected by the order the arms are supplied in", () => {
    const a = reciprocalRankFusion([["x", "y"], ["y"]], K);
    const b = reciprocalRankFusion([["y"], ["x", "y"]], K);
    expect(a.map((row) => row.id)).toEqual(b.map((row) => row.id));
  });
});

describe("fuseTop", () => {
  it("takes the fused leaders", () => {
    expect(fuseTop([["a", "b", "c", "d"]], K, 2)).toEqual(["a", "b"]);
  });

  it("returns everything when there is less than the limit", () => {
    expect(fuseTop([["a"]], K, 5)).toEqual(["a"]);
  });

  it("returns nothing for a non-positive limit", () => {
    expect(fuseTop([["a", "b"]], K, 0)).toEqual([]);
  });
});

describe("summarise", () => {
  it("gives full credit for answered and half for partial", () => {
    // 4 fully + 2 partially over 6 judged → (4 + 1) / 6 = 0.8333 → 83.
    const metrics = summarise(
      [
        ...Array.from({ length: 4 }, () => outcome({ answered: "fully" })),
        ...Array.from({ length: 2 }, () => outcome({ answered: "partially" })),
      ],
      RETRIEVABILITY_V1,
    );

    expect(metrics.hitRate).toBeCloseTo(5 / 6, 12);
    expect(metrics.score).toBe(83);
    expect(metrics.degraded).toBe(false);
  });

  it("scores 100 only when every question is fully answered", () => {
    const metrics = summarise(
      Array.from({ length: 30 }, () => outcome({ answered: "fully" })),
      RETRIEVABILITY_V1,
    );
    expect(metrics.score).toBe(100);
  });

  it("scores 0 when the content answers nothing", () => {
    const metrics = summarise(
      Array.from({ length: 30 }, () => outcome({ answered: "no" })),
      RETRIEVABILITY_V1,
    );
    expect(metrics.score).toBe(0);
    expect(metrics.degraded).toBe(false);
  });

  it("divides by judged questions, not by total — our outage is not their score", () => {
    // 8 judged of 10: 6 fully, 2 no. Hit rate is 6/8, not 6/10.
    const metrics = summarise(
      [
        ...Array.from({ length: 6 }, () => outcome({ answered: "fully" })),
        ...Array.from({ length: 2 }, () => outcome({ answered: "no" })),
        ...Array.from({ length: 2 }, () =>
          outcome({ answered: null, confidence: null, missingElement: null }),
        ),
      ],
      RETRIEVABILITY_V1,
    );

    expect(metrics.questionsTotal).toBe(10);
    expect(metrics.questionsJudged).toBe(8);
    expect(metrics.judgedShare).toBeCloseTo(0.8, 12);
    expect(metrics.hitRate).toBeCloseTo(0.75, 12);
    expect(metrics.score).toBe(75);
  });

  it("degrades to null below the judged-share threshold", () => {
    // 6 of 10 judged is under 70%.
    const metrics = summarise(
      [
        ...Array.from({ length: 6 }, () => outcome({ answered: "fully" })),
        ...Array.from({ length: 4 }, () => outcome({ answered: null })),
      ],
      RETRIEVABILITY_V1,
    );

    expect(metrics.degraded).toBe(true);
    expect(metrics.score).toBeNull();
    expect(metrics.hitRate).toBeNull();
    // The counts survive, so the UI can still explain what happened.
    expect(metrics.questionsJudged).toBe(6);
  });

  it("accepts exactly the threshold", () => {
    const metrics = summarise(
      [
        ...Array.from({ length: 7 }, () => outcome({ answered: "fully" })),
        ...Array.from({ length: 3 }, () => outcome({ answered: null })),
      ],
      RETRIEVABILITY_V1,
    );
    expect(metrics.judgedShare).toBeCloseTo(0.7, 12);
    expect(metrics.degraded).toBe(false);
    expect(metrics.score).toBe(100);
  });

  it("degrades rather than dividing by zero when nothing was judged", () => {
    const metrics = summarise([outcome({ answered: null })], RETRIEVABILITY_V1);
    expect(metrics.score).toBeNull();
    expect(metrics.degraded).toBe(true);
  });

  it("degrades when there were no questions at all", () => {
    const metrics = summarise([], RETRIEVABILITY_V1);
    expect(metrics).toMatchObject({ questionsTotal: 0, score: null, degraded: true });
  });

  it("counts each verdict separately, so the UI can show the split", () => {
    const metrics = summarise(
      [
        outcome({ answered: "fully" }),
        outcome({ answered: "partially" }),
        outcome({ answered: "no" }),
        outcome({ answered: "no" }),
      ],
      RETRIEVABILITY_V1,
    );
    expect(metrics).toMatchObject({
      questionsAnswered: 1,
      questionsPartial: 1,
      questionsUnanswered: 2,
    });
  });
});

describe("unansweredQuestions", () => {
  it("puts confident failures first, then partials", () => {
    const gaps = unansweredQuestions(
      [
        outcome({ question: "answered", answered: "fully" }),
        outcome({ question: "weak partial", answered: "partially", confidence: 40 }),
        outcome({ question: "unsure no", answered: "no", confidence: 55 }),
        outcome({ question: "certain no", answered: "no", confidence: 95 }),
      ],
      10,
    );

    expect(gaps.map((gap) => gap.question)).toEqual(["certain no", "unsure no", "weak partial"]);
  });

  it("excludes questions the content answered", () => {
    const gaps = unansweredQuestions([outcome({ answered: "fully" })], 10);
    expect(gaps).toEqual([]);
  });

  it("excludes questions the judge never reached — that is our gap, not theirs", () => {
    const gaps = unansweredQuestions([outcome({ answered: null })], 10);
    expect(gaps).toEqual([]);
  });

  it("honours the limit", () => {
    const gaps = unansweredQuestions(
      Array.from({ length: 20 }, (_unused, index) =>
        outcome({ question: `q${index}`, answered: "no" }),
      ),
      3,
    );
    expect(gaps).toHaveLength(3);
  });
});

describe("the v1 parameters", () => {
  it("are exactly what the pipeline doc fixes", () => {
    expect(RETRIEVABILITY_V1).toMatchObject({
      version: "retrievability.v1",
      vectorTopK: 20,
      lexicalTopK: 20,
      contextChunks: 5,
      rrfK: 60,
      partialCredit: 0.5,
      minJudgedShare: 0.7,
      minQuestions: 30,
      maxQuestions: 50,
    });
  });
});
