import { describe, expect, it } from "vitest";
import type { PromptResult } from "@contracts/api/prompt-runs";
import { citedUrls, normalizeUrl, pageBlurPx, pickSampleAnswer, readSections } from "@/lib/evidence";

function result(overrides: Partial<PromptResult> = {}): PromptResult {
  return {
    id: "1",
    promptTemplateId: "11111111-1111-1111-1111-111111111111",
    engine: "perplexity",
    sampleIndex: 0,
    brandMentioned: false,
    brandCited: false,
    mentionPosition: null,
    sentiment: null,
    competitorsMentioned: null,
    citations: null,
    answerText: "An answer.",
    model: "sonar",
    latencyMs: 100,
    error: null,
    createdAt: "2026-11-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeUrl", () => {
  it("treats protocol, www, trailing slash, query and hash as the same page", () => {
    const forms = [
      "https://www.Example.com/pricing/",
      "http://example.com/pricing",
      "example.com/pricing?ref=ai",
      "https://example.com/pricing#plans",
    ];
    expect(new Set(forms.map(normalizeUrl))).toEqual(new Set(["example.com/pricing"]));
  });

  it("keeps different paths apart", () => {
    expect(normalizeUrl("https://example.com/pricing")).not.toBe(normalizeUrl("https://example.com/pricing-old"));
  });
});

describe("citedUrls", () => {
  it("collects every citation once, normalized, ignoring answers without citations", () => {
    expect(
      citedUrls([
        result({ citations: ["https://example.com/a/", "https://www.example.com/a"] }),
        result({ citations: null }),
        result({ citations: ["https://other.example/b"] }),
      ]).sort(),
    ).toEqual(["example.com/a", "other.example/b"]);
  });
});

describe("pickSampleAnswer", () => {
  it("prefers an answer that cites the brand, then one that mentions it", () => {
    const plain = result({ id: "1", answerText: "plain" });
    const mention = result({ id: "2", answerText: "mention", brandMentioned: true });
    const cite = result({ id: "3", answerText: "cite", brandMentioned: true, brandCited: true });

    expect(pickSampleAnswer([plain, mention, cite])?.text).toBe("cite");
    expect(pickSampleAnswer([plain, mention])?.text).toBe("mention");
    expect(pickSampleAnswer([plain])?.text).toBe("plain");
  });

  it("returns null when no answer has text (failed cells)", () => {
    expect(pickSampleAnswer([result({ answerText: null, error: "timeout" })])).toBeNull();
    expect(pickSampleAnswer([])).toBeNull();
  });
});

describe("readSections", () => {
  it("reads text and the deepest heading, skipping empty sections", () => {
    expect(
      readSections({
        sections: [
          { text: "Plans start at $9.", headingPath: ["Pricing", "Starter"] },
          { text: "   ", headingPath: ["Empty"] },
          { text: "Intro copy.", headingPath: null },
        ],
      }),
    ).toEqual([
      { heading: "Starter", text: "Plans start at $9." },
      { heading: null, text: "Intro copy." },
    ]);
  });

  it("tolerates a malformed or missing sections field", () => {
    expect(readSections({})).toEqual([]);
    expect(readSections({ sections: "nope" })).toEqual([]);
    expect(readSections({ sections: [null, 42, { text: 7 }] })).toEqual([]);
  });
});

describe("pageBlurPx", () => {
  it("renders a cited page sharp, whatever its quality", () => {
    expect(pageBlurPx({ cited: true, qualityScore: 10 })).toBe(0);
  });

  it("blurs more as quality drops", () => {
    expect(pageBlurPx({ cited: false, qualityScore: 90 })).toBeLessThan(
      pageBlurPx({ cited: false, qualityScore: 30 }),
    );
  });

  it("blurs an unscored page more than any scored one — unmeasured is never read as a score", () => {
    expect(pageBlurPx({ cited: false, qualityScore: null })).toBeGreaterThan(
      pageBlurPx({ cited: false, qualityScore: 0 }),
    );
  });
});
