/**
 * Prompt-run aggregation (M15) — hand-computed fixtures.
 *
 * The rule these tests exist to protect: a failed API call must never become a "not
 * mentioned". In a trend line the two are indistinguishable, and one of them is a lie
 * about the customer's visibility.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_SUCCESSFUL_SAMPLES,
  aggregateCell,
  citationScore,
  summariseRun,
  type CellOutcome,
  type SampleOutcome,
} from "../../../src/domain/prompts/metrics.js";

function sample(overrides: Partial<SampleOutcome> = {}): SampleOutcome {
  return {
    promptTemplateId: "prompt-1",
    engine: "perplexity",
    sampleIndex: 0,
    brandMentioned: true,
    brandCited: true,
    competitorsCited: [],
    failed: false,
    ...overrides,
  };
}

function cell(overrides: Partial<CellOutcome> = {}): CellOutcome {
  return {
    promptTemplateId: "prompt-1",
    engine: "perplexity",
    samples: 3,
    successfulSamples: 3,
    brandMentioned: true,
    brandCited: true,
    competitorsCited: [],
    partial: false,
    ...overrides,
  };
}

describe("majority vote over three samples", () => {
  it("takes two of three as the verdict", () => {
    const outcome = aggregateCell([
      sample({ sampleIndex: 0, brandMentioned: true }),
      sample({ sampleIndex: 1, brandMentioned: true }),
      sample({ sampleIndex: 2, brandMentioned: false }),
    ]);
    expect(outcome.brandMentioned).toBe(true);
  });

  it("takes the other way round too", () => {
    const outcome = aggregateCell([
      sample({ sampleIndex: 0, brandMentioned: false }),
      sample({ sampleIndex: 1, brandMentioned: false }),
      sample({ sampleIndex: 2, brandMentioned: true }),
    ]);
    expect(outcome.brandMentioned).toBe(false);
  });

  it("votes mentions and citations independently", () => {
    const outcome = aggregateCell([
      sample({ sampleIndex: 0, brandMentioned: true, brandCited: false }),
      sample({ sampleIndex: 1, brandMentioned: true, brandCited: false }),
      sample({ sampleIndex: 2, brandMentioned: true, brandCited: true }),
    ]);
    expect(outcome.brandMentioned).toBe(true);
    expect(outcome.brandCited).toBe(false);
  });

  it("collects every competitor cited in any successful sample", () => {
    const outcome = aggregateCell([
      sample({ sampleIndex: 0, competitorsCited: ["rival.com"] }),
      sample({ sampleIndex: 1, competitorsCited: ["other.com", "rival.com"] }),
      sample({ sampleIndex: 2, competitorsCited: [] }),
    ]);
    expect(outcome.competitorsCited).toEqual(["other.com", "rival.com"]);
  });
});

describe("a cell that could not be measured", () => {
  it("is partial when fewer than two samples succeeded", () => {
    const outcome = aggregateCell([
      sample({ sampleIndex: 0, failed: true, brandMentioned: null, brandCited: null }),
      sample({ sampleIndex: 1, failed: true, brandMentioned: null, brandCited: null }),
      sample({ sampleIndex: 2 }),
    ]);

    expect(outcome.partial).toBe(true);
    expect(outcome.successfulSamples).toBe(1);
    // Null, not false. False would say "we asked and they were not mentioned".
    expect(outcome.brandMentioned).toBeNull();
    expect(outcome.brandCited).toBeNull();
  });

  it("is evaluable at exactly the threshold", () => {
    const outcome = aggregateCell([
      sample({ sampleIndex: 0, failed: true, brandMentioned: null, brandCited: null }),
      sample({ sampleIndex: 1 }),
      sample({ sampleIndex: 2 }),
    ]);
    expect(outcome.successfulSamples).toBe(MIN_SUCCESSFUL_SAMPLES);
    expect(outcome.partial).toBe(false);
    expect(outcome.brandMentioned).toBe(true);
  });

  it("is partial when every sample failed", () => {
    const outcome = aggregateCell([
      sample({ sampleIndex: 0, failed: true, brandMentioned: null, brandCited: null }),
      sample({ sampleIndex: 1, failed: true, brandMentioned: null, brandCited: null }),
      sample({ sampleIndex: 2, failed: true, brandMentioned: null, brandCited: null }),
    ]);
    expect(outcome.partial).toBe(true);
    expect(outcome.brandMentioned).toBeNull();
  });
});

describe("run metrics", () => {
  it("computes rates over evaluable cells", () => {
    // Four cells: three mention, two cite.
    const metrics = summariseRun([
      cell({ promptTemplateId: "a", brandMentioned: true, brandCited: true }),
      cell({ promptTemplateId: "b", brandMentioned: true, brandCited: true }),
      cell({ promptTemplateId: "c", brandMentioned: true, brandCited: false }),
      cell({ promptTemplateId: "d", brandMentioned: false, brandCited: false }),
    ]);

    expect(metrics.evaluableCells).toBe(4);
    expect(metrics.mentionRate).toBe(75);
    expect(metrics.citationShare).toBe(50);
  });

  it("excludes partial cells from the denominator, never counting them as a miss", () => {
    const withPartial = summariseRun([
      cell({ promptTemplateId: "a", brandMentioned: true, brandCited: true }),
      cell({ promptTemplateId: "b", brandMentioned: true, brandCited: true }),
      cell({
        promptTemplateId: "c",
        partial: true,
        successfulSamples: 0,
        brandMentioned: null,
        brandCited: null,
      }),
    ]);

    expect(withPartial.cells).toBe(3);
    expect(withPartial.evaluableCells).toBe(2);
    expect(withPartial.partialCells).toBe(1);
    // 2/2, not 2/3 — the third cell was not measured, not measured as absent.
    expect(withPartial.mentionRate).toBe(100);
  });

  it("reports null rather than zero when nothing was evaluable", () => {
    const metrics = summariseRun([
      cell({ partial: true, successfulSamples: 0, brandMentioned: null, brandCited: null }),
    ]);
    expect(metrics.mentionRate).toBeNull();
    expect(metrics.citationShare).toBeNull();
    expect(metrics.degraded).toBe(true);
  });

  it("breaks the numbers down per engine", () => {
    const metrics = summariseRun([
      cell({ engine: "perplexity", promptTemplateId: "a", brandCited: true }),
      cell({ engine: "perplexity", promptTemplateId: "b", brandCited: false }),
      cell({ engine: "openai", promptTemplateId: "a", brandCited: false }),
      cell({ engine: "openai", promptTemplateId: "b", brandCited: false }),
    ]);

    const perplexity = metrics.perEngine.find((engine) => engine.engine === "perplexity");
    const openai = metrics.perEngine.find((engine) => engine.engine === "openai");
    expect(perplexity?.citationShare).toBe(50);
    expect(openai?.citationShare).toBe(0);
  });

  it("marks the run degraded when one engine produced nothing usable", () => {
    const metrics = summariseRun([
      cell({ engine: "perplexity", promptTemplateId: "a" }),
      cell({
        engine: "openai",
        promptTemplateId: "a",
        partial: true,
        successfulSamples: 0,
        brandMentioned: null,
        brandCited: null,
      }),
    ]);

    expect(metrics.degraded).toBe(true);
    // …and the engine that answered still reports a real number.
    expect(metrics.perEngine.find((engine) => engine.engine === "perplexity")?.citationShare).toBe(
      100,
    );
  });

  it("is not degraded when both engines answered", () => {
    const metrics = summariseRun([
      cell({ engine: "perplexity", promptTemplateId: "a" }),
      cell({ engine: "openai", promptTemplateId: "a" }),
    ]);
    expect(metrics.degraded).toBe(false);
  });
});

describe("share of voice", () => {
  it("is our citations over ours plus every competitor's", () => {
    const metrics = summariseRun([
      cell({ promptTemplateId: "a", brandCited: true, competitorsCited: ["rival.com"] }),
      cell({ promptTemplateId: "b", brandCited: false, competitorsCited: ["rival.com"] }),
    ]);
    // One of ours, two of theirs.
    expect(metrics.shareOfVoice).toBeCloseTo(33.33, 1);
    expect(metrics.competitorCitations).toEqual({ "rival.com": 2 });
  });

  it("is 100 when only we are cited", () => {
    const metrics = summariseRun([cell({ brandCited: true })]);
    expect(metrics.shareOfVoice).toBe(100);
  });

  it("is 0 when only competitors are cited", () => {
    const metrics = summariseRun([cell({ brandCited: false, competitorsCited: ["rival.com"] })]);
    expect(metrics.shareOfVoice).toBe(0);
  });

  it("is null when nobody was cited — undefined, not zero", () => {
    const metrics = summariseRun([cell({ brandCited: false })]);
    expect(metrics.shareOfVoice).toBeNull();
  });

  it("computes per engine as well as overall", () => {
    const metrics = summariseRun([
      cell({ engine: "perplexity", brandCited: true, competitorsCited: [] }),
      cell({ engine: "openai", brandCited: false, competitorsCited: ["rival.com"] }),
    ]);
    expect(metrics.perEngine.find((engine) => engine.engine === "perplexity")?.shareOfVoice).toBe(
      100,
    );
    expect(metrics.perEngine.find((engine) => engine.engine === "openai")?.shareOfVoice).toBe(0);
    expect(metrics.shareOfVoice).toBe(50);
  });
});

describe("the citation component score", () => {
  it("weights being linked above being named", () => {
    // 0.6·80 + 0.4·40 = 48 + 16 = 64.
    const metrics = summariseRun([
      cell({ promptTemplateId: "a", brandMentioned: true, brandCited: true }),
      cell({ promptTemplateId: "b", brandMentioned: false, brandCited: true }),
      cell({ promptTemplateId: "c", brandMentioned: false, brandCited: true }),
      cell({ promptTemplateId: "d", brandMentioned: false, brandCited: true }),
      cell({ promptTemplateId: "e", brandMentioned: true, brandCited: false }),
    ]);
    // citationShare 80, mentionRate 40.
    expect(metrics.citationShare).toBe(80);
    expect(metrics.mentionRate).toBe(40);
    expect(citationScore(metrics)).toBe(64);
  });

  it("is 100 only when every cell both mentions and cites", () => {
    expect(citationScore(summariseRun([cell()]))).toBe(100);
  });

  it("is null when the run measured nothing", () => {
    const metrics = summariseRun([
      cell({ partial: true, successfulSamples: 0, brandMentioned: null, brandCited: null }),
    ]);
    expect(citationScore(metrics)).toBeNull();
  });
});
