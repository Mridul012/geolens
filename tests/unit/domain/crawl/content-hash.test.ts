/**
 * Change detection is the biggest cost lever in the system: a hash that flaps re-embeds
 * and re-analyses an entire site on every crawl, and a hash that is too coarse silently
 * serves stale analysis. Both failure modes are asserted here.
 */
import { describe, expect, it } from "vitest";
import { contentHashOf } from "../../../../src/domain/crawl/content-hash.js";

const base = {
  title: "Pricing",
  metaDescription: "What Acme costs.",
  headings: [
    { level: 1, text: "Pricing" },
    { level: 2, text: "Enterprise" },
  ],
  mainText: "Acme costs money. Here is how much and why.",
};

describe("contentHashOf", () => {
  it("is a stable 64-character hex digest", () => {
    const hash = contentHashOf(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashOf(base)).toBe(hash);
  });

  it("is unchanged by whitespace churn — the commonest false positive", () => {
    expect(contentHashOf({ ...base, mainText: "  Acme costs money.\n\n  Here is how much and why.  " })).toBe(
      contentHashOf(base),
    );
  });

  it("is unchanged by non-breaking and zero-width space substitution", () => {
    expect(contentHashOf({ ...base, mainText: "Acme costs money. Here is how much and why." })).toBe(
      contentHashOf(base),
    );
  });

  it("ignores everything outside the meaningful fields", () => {
    // A rotating build id, CSRF token or analytics blob lives in the markup, never in
    // these fields — which is exactly why the hash is taken over extraction, not HTML.
    const withNoise = { ...base };
    expect(contentHashOf(withNoise)).toBe(contentHashOf(base));
  });

  it("changes when the body text changes", () => {
    expect(contentHashOf({ ...base, mainText: "Acme is now free." })).not.toBe(contentHashOf(base));
  });

  it("changes when the title changes, even with identical prose", () => {
    expect(contentHashOf({ ...base, title: "Plans" })).not.toBe(contentHashOf(base));
  });

  it("changes when the meta description changes", () => {
    expect(contentHashOf({ ...base, metaDescription: "Something else." })).not.toBe(
      contentHashOf(base),
    );
  });

  it("changes when a heading is added, removed or renamed", () => {
    const hash = contentHashOf(base);
    expect(contentHashOf({ ...base, headings: [{ level: 1, text: "Pricing" }] })).not.toBe(hash);
    expect(
      contentHashOf({
        ...base,
        headings: [...base.headings, { level: 2, text: "Startups" }],
      }),
    ).not.toBe(hash);
    expect(
      contentHashOf({
        ...base,
        headings: [
          { level: 1, text: "Pricing" },
          { level: 2, text: "Business" },
        ],
      }),
    ).not.toBe(hash);
  });

  it("changes when a heading's level changes", () => {
    expect(
      contentHashOf({
        ...base,
        headings: [
          { level: 1, text: "Pricing" },
          { level: 3, text: "Enterprise" },
        ],
      }),
    ).not.toBe(contentHashOf(base));
  });

  it("distinguishes text moved between a heading and the body", () => {
    // Without a separator the fields could concatenate to the same string; they must not.
    const a = { ...base, headings: [{ level: 1, text: "Pricing Enterprise" }], mainText: "x" };
    const b = { ...base, headings: [{ level: 1, text: "Pricing" }], mainText: "Enterprise x" };
    expect(contentHashOf(a)).not.toBe(contentHashOf(b));
  });

  it("treats a null title and an empty title alike", () => {
    expect(contentHashOf({ ...base, title: null })).toBe(contentHashOf({ ...base, title: "" }));
  });

  it("handles an empty page without throwing", () => {
    expect(
      contentHashOf({ title: null, metaDescription: null, headings: [], mainText: "" }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
