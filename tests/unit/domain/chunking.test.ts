/**
 * Heading-aware chunking (M10): the properties a retriever depends on.
 *
 * Sizes are asserted against `estimateTokens`, the same estimator the chunker budgets
 * with — asserting against a different notion of a token would test the estimator, not the
 * chunker.
 */
import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_TOKENS,
  CHUNK_MIN_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  chunkDocument,
  embeddableText,
  type DocumentSection,
} from "../../../src/domain/content/chunking.js";
import { estimateTokens } from "../../../src/domain/content/text.js";

/** ~`tokens` tokens of distinct sentences, so overlap is visible in a diff. */
function prose(tokens: number, marker = "word"): string {
  const sentences: string[] = [];
  let index = 0;
  while (estimateTokens(sentences.join(" ")) < tokens) {
    index += 1;
    sentences.push(`This is sentence ${index} about ${marker} and its many implications.`);
  }
  return sentences.join(" ");
}

describe("chunkDocument", () => {
  it("keeps one section in one chunk when it fits", () => {
    const sections: DocumentSection[] = [
      { headingPath: "Pricing", text: prose(200, "pricing") },
      { headingPath: "Security", text: prose(200, "security") },
    ];

    const chunks = chunkDocument({ sections });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headingPath).toBe("Pricing");
    expect(chunks[1]?.headingPath).toBe("Security");
    expect(chunks[0]?.content).not.toContain("security");
  });

  it("numbers chunks from zero, densely, in document order", () => {
    const sections = Array.from({ length: 5 }, (_unused, index) => ({
      headingPath: `H${index}`,
      text: prose(200, `topic${index}`),
    }));

    const chunks = chunkDocument({ sections });

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the hard ceiling", () => {
    const chunks = chunkDocument({
      sections: [{ headingPath: "Long", text: prose(3_000, "throughput") }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    }
  });

  it("keeps the heading path on every piece of a split section", () => {
    const chunks = chunkDocument({
      sections: [{ headingPath: "Docs > API > Auth", text: prose(2_000, "tokens") }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.headingPath === "Docs > API > Auth")).toBe(true);
  });

  it("overlaps consecutive pieces so a claim on the boundary stays retrievable", () => {
    const chunks = chunkDocument({
      sections: [{ headingPath: "Long", text: prose(1_500, "latency") }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0]?.content ?? "";
    const second = chunks[1]?.content ?? "";

    // The overlap is a suffix of one piece and a prefix of the next, so the sentence that
    // ends the first chunk must reappear near the top of the second.
    const tail = first.split(/(?<=[.!?])\s+/).at(-1) ?? "";
    expect(tail.length).toBeGreaterThan(0);
    expect(second).toContain(tail);
    expect(second.indexOf(tail)).toBeLessThan(CHUNK_OVERLAP_TOKENS * 4);
    // …and the second chunk is more than just the overlap.
    expect(second.length).toBeGreaterThan(tail.length * 2);
  });

  it("splits on sentence boundaries, never mid-sentence", () => {
    const chunks = chunkDocument({
      sections: [{ headingPath: null, text: prose(1_200, "boundaries") }],
    });

    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.content.trim().endsWith(".")).toBe(true);
    }
  });

  it("hard-splits a single sentence longer than the ceiling rather than emitting it whole", () => {
    const runOn = Array.from({ length: 1_200 }, (_unused, index) => `word${index}`).join(" ");
    const chunks = chunkDocument({ sections: [{ headingPath: null, text: runOn }] });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    }
  });

  it("merges small neighbouring sections instead of emitting a chunk per stanza", () => {
    const sections = Array.from({ length: 6 }, (_unused, index) => ({
      headingPath: `Features > Item ${index}`,
      text: `A short line about item ${index}.`,
    }));

    const chunks = chunkDocument({ sections });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("item 0");
    expect(chunks[0]?.content).toContain("item 5");
  });

  it("attributes a merged chunk to the shared ancestor, not to one arbitrary sibling", () => {
    const chunks = chunkDocument({
      sections: [
        { headingPath: "Pricing > Plans > Starter", text: "Ten dollars a month." },
        { headingPath: "Pricing > Plans > Growth", text: "Fifty dollars a month." },
      ],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBe("Pricing > Plans");
  });

  it("falls back to null when merged sections share no ancestor at all", () => {
    const chunks = chunkDocument({
      sections: [
        { headingPath: "Pricing", text: "Ten dollars a month." },
        { headingPath: "Security", text: "We are SOC 2 compliant." },
      ],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBeNull();
  });

  it("never leaves an undersized chunk beside one it could have joined", () => {
    const chunks = chunkDocument({
      sections: [
        { headingPath: "Body", text: prose(200, "detail") },
        { headingPath: "Note", text: "One short trailing note." },
      ],
    });

    const undersized = chunks.filter((chunk) => chunk.tokenCount < CHUNK_MIN_TOKENS);
    expect(undersized).toEqual([]);
  });

  it("keeps a genuinely tiny page as one tiny chunk rather than dropping it", () => {
    const chunks = chunkDocument({ sections: [{ headingPath: null, text: "Coming soon." }] });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("Coming soon.");
  });

  it("chunks the fallback text when a page has no headings", () => {
    const chunks = chunkDocument({ sections: [], fallbackText: prose(300, "unheaded") });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBeNull();
  });

  it("prefers real sections over the fallback when both are present", () => {
    const chunks = chunkDocument({
      sections: [{ headingPath: "Real", text: prose(100, "real") }],
      fallbackText: prose(100, "fallback"),
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).not.toContain("fallback");
  });

  it("returns nothing for a page with no readable prose", () => {
    expect(chunkDocument({ sections: [], fallbackText: "   " })).toEqual([]);
    expect(chunkDocument({ sections: [{ headingPath: "Empty", text: "  " }] })).toEqual([]);
  });

  it("is deterministic — the same page re-crawled produces identical chunks", () => {
    const sections: DocumentSection[] = [
      { headingPath: "A", text: prose(700, "alpha") },
      { headingPath: "B", text: prose(120, "beta") },
    ];

    expect(chunkDocument({ sections })).toEqual(chunkDocument({ sections }));
  });

  it("reports a token count matching its own content", () => {
    for (const chunk of chunkDocument({ sections: [{ headingPath: "X", text: prose(900) }] })) {
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
    }
  });
});

describe("embeddableText", () => {
  it("prepends the heading path so retrieval sees the breadcrumb", () => {
    expect(embeddableText({ headingPath: "Pricing > Enterprise", content: "Custom terms." })).toBe(
      "Pricing > Enterprise\nCustom terms.",
    );
  });

  it("leaves unheaded content alone", () => {
    expect(embeddableText({ headingPath: null, content: "Custom terms." })).toBe("Custom terms.");
  });
});
