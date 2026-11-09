import { describe, expect, it } from "vitest";
import {
  countWords,
  estimateTokens,
  headingPath,
  normalizeWhitespace,
  truncateToTokenBudget,
  truncateWords,
} from "../../../../src/domain/content/text.js";

describe("normalizeWhitespace", () => {
  it("collapses runs and trims", () => {
    expect(normalizeWhitespace("  a   b \n\t c  ")).toBe("a b c");
  });

  it("handles the whitespace CMSs actually emit", () => {
    expect(normalizeWhitespace("a b")).toBe("a b");
    expect(normalizeWhitespace("a​b")).toBe("a b");
  });

  it("returns empty for whitespace-only input", () => {
    expect(normalizeWhitespace("   \n  ")).toBe("");
  });
});

describe("countWords", () => {
  it("counts prose words", () => {
    expect(countWords("The quick brown fox")).toBe(4);
  });

  it("ignores punctuation-only tokens", () => {
    expect(countWords("hello — world • !")).toBe(2);
  });

  it("counts numbers and alphanumerics as words", () => {
    expect(countWords("we raised $12M in 2024")).toBe(5);
  });

  it("counts non-Latin scripts", () => {
    expect(countWords("नमस्ते दुनिया")).toBe(2);
    expect(countWords("日本語 テスト")).toBe(2);
  });

  it("returns 0 for empty or symbol-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("··· ---")).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("scales with length and is stable", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("truncateWords", () => {
  it("cuts on a word boundary", () => {
    expect(truncateWords("one two three four", 2)).toBe("one two");
  });

  it("returns the whole string when it already fits", () => {
    expect(truncateWords("one two", 5)).toBe("one two");
  });

  it("returns empty for a non-positive budget", () => {
    expect(truncateWords("one two", 0)).toBe("");
  });
});

describe("truncateToTokenBudget", () => {
  it("leaves short text alone", () => {
    expect(truncateToTokenBudget("short text", 100)).toBe("short text");
  });

  it("brings long text within budget", () => {
    const long = "word ".repeat(2_000);
    const result = truncateToTokenBudget(long, 100);
    expect(estimateTokens(result)).toBeLessThanOrEqual(100);
    expect(result.endsWith("word")).toBe(true);
  });
});

describe("headingPath", () => {
  it("joins the ancestor chain", () => {
    expect(headingPath([{ level: 1, text: "Pricing" }], 2, "Enterprise")).toBe(
      "Pricing > Enterprise",
    );
  });

  it("ignores ancestors at or below the current level", () => {
    const ancestors = [
      { level: 1, text: "Docs" },
      { level: 2, text: "Guides" },
      { level: 3, text: "Sibling" },
    ];
    expect(headingPath(ancestors, 3, "Setup")).toBe("Docs > Guides > Setup");
  });

  it("is just the heading when there is no ancestry", () => {
    expect(headingPath([], 1, "Home")).toBe("Home");
  });
});
