/**
 * Mention and citation detection (M15) — the fixture matrix the milestone names:
 * mentioned, cited, neither, competitor-only, and the ambiguous case that escalates.
 *
 * This parser decides the largest-weighted component in the composite. A false positive
 * inflates a customer's headline number; a false negative tells them they lost visibility
 * they never lost. Both are worse than a missing measurement, so each case is pinned.
 */
import { describe, expect, it } from "vitest";
import {
  brandVariants,
  domainRoot,
  isCommonWord,
  normalizeForMatching,
} from "../../../src/domain/prompts/variants.js";
import {
  detectCitation,
  detectMention,
  extractUrls,
  positionBucket,
} from "../../../src/domain/prompts/matching.js";

const ACME = brandVariants({
  siteName: "Acme Analytics",
  projectName: "Acme",
  registrableDomain: "acme.com",
});

describe("normalization", () => {
  it("casefolds, strips diacritics and collapses whitespace", () => {
    expect(normalizeForMatching("  Nestlé   S.A.  ")).toBe("nestle s a");
  });

  it("strips punctuation rather than deleting it, so words stay separate", () => {
    // "geo-lens" must become two words, not "geolens".
    expect(normalizeForMatching("Geo-Lens")).toBe("geo lens");
  });

  it("is idempotent", () => {
    const once = normalizeForMatching("Acme, Inc.");
    expect(normalizeForMatching(once)).toBe(once);
  });
});

describe("brand variants", () => {
  it("includes the site name, the project name and the domain root", () => {
    expect(ACME).toContain("acme analytics");
    expect(ACME).toContain("acme");
  });

  it("strips a bolted-on domain prefix", () => {
    const variants = brandVariants({
      siteName: null,
      projectName: null,
      registrableDomain: "getgeolens.com",
    });
    expect(variants).toContain("getgeolens");
    expect(variants).toContain("geolens");
  });

  it("does not strip a prefix that would leave a stub", () => {
    const variants = brandVariants({
      siteName: null,
      projectName: null,
      registrableDomain: "gogo.com",
    });
    expect(variants).toEqual(["gogo"]);
  });

  it("orders longest first, so the most specific spelling claims the match", () => {
    const lengths = ACME.map((variant) => variant.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  it("omits the full domain — a URL is a citation, not a mention", () => {
    expect(ACME).not.toContain("acme com");
  });

  it("deduplicates when the name and the domain agree", () => {
    const variants = brandVariants({
      siteName: "Acme",
      projectName: "acme",
      registrableDomain: "acme.com",
    });
    expect(variants).toEqual(["acme"]);
  });

  it("extracts the domain root without its suffix", () => {
    expect(domainRoot("acme.com")).toBe("acme");
    expect(domainRoot("acme.co.uk")).toBe("acme");
  });
});

describe("the fixture matrix", () => {
  it("mentioned: names the brand in prose", () => {
    const match = detectMention(
      "For small teams, Acme Analytics is the usual recommendation, alongside two others.",
      ACME,
    );
    expect(match.matched).toBe(true);
    expect(match.variant).toBe("acme analytics");
    expect(match.ambiguous).toBe(false);
  });

  it("neither: an answer about the category that never names us", () => {
    const match = detectMention(
      "Most teams start with a spreadsheet and move to a dedicated tool later.",
      ACME,
    );
    expect(match.matched).toBe(false);
    expect(match.position).toBeNull();
  });

  it("competitor-only: names a rival and not us", () => {
    const match = detectMention("Rivalcorp is the market leader in this space.", ACME);
    expect(match.matched).toBe(false);
  });

  it("does not match a brand name inside a longer word on a word-boundary pass", () => {
    // "acmeic" is not us. It escalates as a substring match rather than counting silently.
    const match = detectMention("The acmeic approach is popular.", ACME);
    expect(match.ambiguityReason).toBe("substring_only");
    expect(match.ambiguous).toBe(true);
  });

  it("matches across punctuation the normalizer removes", () => {
    expect(detectMention("Try Acme's analytics product.", ACME).matched).toBe(true);
  });

  it("matches a multi-word brand written with different spacing", () => {
    expect(detectMention("We recommend Acme  Analytics for this.", ACME).matched).toBe(true);
  });
});

describe("escalation triggers", () => {
  it("escalates a brand named after a common English word", () => {
    const notion = brandVariants({
      siteName: "Notion",
      projectName: null,
      registrableDomain: "notion.so",
    });
    const match = detectMention("You could keep the notion of a single workspace.", notion);

    expect(match.matched).toBe(true);
    expect(match.ambiguous).toBe(true);
    expect(match.ambiguityReason).toBe("common_word");
  });

  it("escalates a very short brand name", () => {
    const short = brandVariants({ siteName: "Ao", projectName: null, registrableDomain: "ao.com" });
    const match = detectMention("The ao framework is worth a look.", short);

    expect(match.ambiguous).toBe(true);
    expect(match.ambiguityReason).toBe("short_variant");
  });

  it("does not escalate an ordinary distinctive name", () => {
    const match = detectMention("Acme Analytics handles this well.", ACME);
    expect(match.ambiguous).toBe(false);
    expect(match.ambiguityReason).toBeNull();
  });

  it("knows which words are common enough to need a second look", () => {
    expect(isCommonWord("notion")).toBe(true);
    expect(isCommonWord("stripe")).toBe(true);
    expect(isCommonWord("linear")).toBe(true);
    expect(isCommonWord("geolens")).toBe(false);
  });
});

describe("mention position", () => {
  it("buckets by percentile through the answer", () => {
    expect(positionBucket(0, 100)).toBe("early");
    expect(positionBucket(33, 100)).toBe("early");
    expect(positionBucket(50, 100)).toBe("mid");
    expect(positionBucket(66, 100)).toBe("mid");
    expect(positionBucket(90, 100)).toBe("late");
  });

  it("reports where the brand first appeared", () => {
    const early = detectMention(`Acme is first. ${"Other prose. ".repeat(40)}`, ACME);
    const late = detectMention(`${"Other prose. ".repeat(40)} Acme is last.`, ACME);

    expect(early.position).toBe("early");
    expect(late.position).toBe("late");
  });

  it("does not divide by zero on an empty answer", () => {
    expect(detectMention("", ACME).matched).toBe(false);
    expect(positionBucket(0, 0)).toBe("early");
  });
});

describe("citation detection", () => {
  it("counts a citation to the brand's own registrable domain", () => {
    const match = detectCitation(
      [{ url: "https://acme.com/pricing", registrableDomain: "acme.com" }],
      "acme.com",
    );
    expect(match.cited).toBe(true);
    expect(match.matchedUrls).toEqual(["https://acme.com/pricing"]);
  });

  it("counts a subdomain as the same business citing itself", () => {
    const match = detectCitation(
      [{ url: "https://blog.acme.com/post", registrableDomain: "acme.com" }],
      "acme.com",
    );
    expect(match.cited).toBe(true);
  });

  it("does not count a lookalike domain", () => {
    // The bug a naive suffix check makes: `notacme.com` ends with `acme.com`.
    const match = detectCitation(
      [{ url: "https://notacme.com/post", registrableDomain: "notacme.com" }],
      "acme.com",
    );
    expect(match.cited).toBe(false);
  });

  it("ignores a citation that resolved to no registrable domain", () => {
    const match = detectCitation([{ url: "https://192.168.1.1/", registrableDomain: null }], "acme.com");
    expect(match.cited).toBe(false);
  });

  it("is case-insensitive about the domain", () => {
    expect(
      detectCitation([{ url: "https://ACME.com/x", registrableDomain: "ACME.com" }], "acme.com")
        .cited,
    ).toBe(true);
  });

  it("reports nothing cited for an answer with no sources", () => {
    expect(detectCitation([], "acme.com")).toEqual({ cited: false, matchedUrls: [] });
  });
});

describe("finding URLs in prose", () => {
  it("pulls bare URLs out of an answer", () => {
    expect(extractUrls("See https://acme.com/pricing for details.")).toEqual([
      "https://acme.com/pricing",
    ]);
  });

  it("pulls the target out of a markdown link, without the paren", () => {
    expect(extractUrls("See [pricing](https://acme.com/pricing) for details.")).toContain(
      "https://acme.com/pricing",
    );
  });

  it("does not swallow trailing sentence punctuation", () => {
    expect(extractUrls("Read https://acme.com/docs.")).toEqual(["https://acme.com/docs"]);
  });

  it("deduplicates a URL cited twice", () => {
    expect(
      extractUrls("https://acme.com/a and again https://acme.com/a"),
    ).toEqual(["https://acme.com/a"]);
  });

  it("finds nothing in an answer with no links", () => {
    expect(extractUrls("No sources here at all.")).toEqual([]);
  });
});
