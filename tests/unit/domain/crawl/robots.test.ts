/**
 * robots.txt semantics. These verdicts become customer-facing findings ("you are blocking
 * GPTBot"), so a wrong answer here is worse than no answer.
 */
import { describe, expect, it } from "vitest";
import {
  crawlDelayFor,
  EMPTY_ROBOTS,
  groupFor,
  isPathAllowed,
  matchesPattern,
  parseRobotsTxt,
} from "../../../../src/domain/crawl/robots.js";

describe("parseRobotsTxt", () => {
  it("parses groups, rules and sitemaps", () => {
    const robots = parseRobotsTxt(`
      # a comment
      Sitemap: https://acme.com/sitemap.xml

      User-agent: *
      Disallow: /admin
      Allow: /admin/public
      Crawl-delay: 2

      User-agent: GPTBot
      Disallow: /
    `);

    expect(robots.present).toBe(true);
    expect(robots.sitemaps).toEqual(["https://acme.com/sitemap.xml"]);
    expect(robots.groups).toHaveLength(2);
    expect(robots.groups[0]?.agents).toEqual(["*"]);
    expect(robots.groups[0]?.crawlDelaySeconds).toBe(2);
    expect(robots.groups[1]?.agents).toEqual(["gptbot"]);
  });

  it("merges consecutive user-agent lines into one group", () => {
    const robots = parseRobotsTxt(`
      User-agent: GPTBot
      User-agent: ClaudeBot
      Disallow: /private
    `);
    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(["gptbot", "claudebot"]);
  });

  it("treats an empty Disallow as no rule at all", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow:");
    expect(robots.groups[0]?.rules).toEqual([]);
    expect(isPathAllowed(robots, "GPTBot", "/anything").allowed).toBe(true);
  });

  it("survives comments, BOMs, CRLF and junk directives", () => {
    const robots = parseRobotsTxt(
      "﻿User-agent: *\r\nDisallow: /x # trailing comment\r\nWibble: nonsense\r\n\r\n",
    );
    expect(robots.groups[0]?.rules).toEqual([{ type: "disallow", path: "/x" }]);
  });

  it("ignores lines with no separator", () => {
    const robots = parseRobotsTxt("this is not a directive\nUser-agent: *\nDisallow: /a");
    expect(robots.groups).toHaveLength(1);
  });

  it("returns an empty-but-present result for an empty file", () => {
    const robots = parseRobotsTxt("");
    expect(robots.present).toBe(true);
    expect(robots.groups).toEqual([]);
  });
});

describe("matchesPattern", () => {
  it.each([
    ["/admin", "/admin", true],
    ["/admin", "/admin/users", true],
    ["/admin", "/administrator", true],
    ["/admin$", "/admin", true],
    ["/admin$", "/admin/users", false],
    ["/*.pdf$", "/files/report.pdf", true],
    ["/*.pdf$", "/files/report.pdf?x=1", false],
    ["/a/*/c", "/a/b/c", true],
    ["/a/*/c", "/a/c", false],
    ["/", "/anything", true],
    ["/blog", "/news", false],
  ])("pattern %s vs %s → %s", (pattern, path, expected) => {
    expect(matchesPattern(pattern, path)).toBe(expected);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(matchesPattern("/a.b", "/a.b")).toBe(true);
    expect(matchesPattern("/a.b", "/axb")).toBe(false);
    expect(matchesPattern("/price(new)", "/price(new)")).toBe(true);
  });
});

describe("groupFor", () => {
  const robots = parseRobotsTxt(`
    User-agent: *
    Disallow: /star

    User-agent: Googlebot
    Disallow: /google

    User-agent: Googlebot-News
    Disallow: /news
  `);

  it("prefers an exact token over the wildcard group", () => {
    expect(groupFor(robots, "Googlebot")?.rules[0]?.path).toBe("/google");
  });

  it("prefers the longest matching token", () => {
    expect(groupFor(robots, "Googlebot-News")?.rules[0]?.path).toBe("/news");
  });

  it("falls back to the wildcard group for an unknown agent", () => {
    expect(groupFor(robots, "GEOlensBot")?.rules[0]?.path).toBe("/star");
  });

  it("is case-insensitive", () => {
    expect(groupFor(robots, "GOOGLEBOT")?.rules[0]?.path).toBe("/google");
  });

  it("returns null when there is no applicable group", () => {
    expect(groupFor(parseRobotsTxt("User-agent: Bingbot\nDisallow: /"), "GPTBot")).toBeNull();
  });
});

describe("isPathAllowed", () => {
  it("blocks a bot disallowed from the whole site", () => {
    const robots = parseRobotsTxt("User-agent: GPTBot\nDisallow: /");
    const verdict = isPathAllowed(robots, "GPTBot", "/pricing");
    expect(verdict.allowed).toBe(false);
    expect(verdict.matchedRule).toEqual({ type: "disallow", path: "/" });
    expect(verdict.matchedAgent).toBe("gptbot");
  });

  it("leaves other bots alone when one is blocked", () => {
    const robots = parseRobotsTxt("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /");
    expect(isPathAllowed(robots, "GPTBot", "/pricing").allowed).toBe(false);
    expect(isPathAllowed(robots, "ClaudeBot", "/pricing").allowed).toBe(true);
  });

  it("lets the longest matching rule win", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /admin\nAllow: /admin/public");
    expect(isPathAllowed(robots, "AnyBot", "/admin/secret").allowed).toBe(false);
    expect(isPathAllowed(robots, "AnyBot", "/admin/public/page").allowed).toBe(true);
  });

  it("lets Allow win a tie of equal length", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /x\nAllow: /x");
    expect(isPathAllowed(robots, "AnyBot", "/x").allowed).toBe(true);
  });

  it("defaults to allowed when robots.txt is absent", () => {
    const verdict = isPathAllowed(EMPTY_ROBOTS, "GPTBot", "/anything");
    expect(verdict.allowed).toBe(true);
    expect(verdict.matchedRule).toBeNull();
  });

  it("defaults to allowed when no group applies", () => {
    const robots = parseRobotsTxt("User-agent: Bingbot\nDisallow: /");
    expect(isPathAllowed(robots, "GPTBot", "/").allowed).toBe(true);
  });

  it("handles the whole matrix of AI bots the product reports on", () => {
    const robots = parseRobotsTxt(`
      User-agent: GPTBot
      Disallow: /

      User-agent: CCBot
      Disallow: /

      User-agent: *
      Disallow: /internal
    `);

    expect(isPathAllowed(robots, "GPTBot", "/").allowed).toBe(false);
    expect(isPathAllowed(robots, "CCBot", "/").allowed).toBe(false);
    expect(isPathAllowed(robots, "ClaudeBot", "/").allowed).toBe(true);
    expect(isPathAllowed(robots, "PerplexityBot", "/").allowed).toBe(true);
    expect(isPathAllowed(robots, "Google-Extended", "/").allowed).toBe(true);
    expect(isPathAllowed(robots, "Bytespider", "/internal/x").allowed).toBe(false);
  });
});

describe("crawlDelayFor", () => {
  it("reads the delay from the applicable group", () => {
    const robots = parseRobotsTxt("User-agent: *\nCrawl-delay: 10");
    expect(crawlDelayFor(robots, "GEOlensBot")).toBe(10);
  });

  it("returns null when unspecified", () => {
    expect(crawlDelayFor(parseRobotsTxt("User-agent: *\nDisallow: /x"), "GEOlensBot")).toBeNull();
  });
});
