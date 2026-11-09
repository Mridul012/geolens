/**
 * The access-check fixture matrix (M8 acceptance): fully open, robots-blocked per bot,
 * CDN-blocked, and llms.txt present/absent/invalid — each producing the right finding and
 * the right fix text.
 *
 * These verdicts are shown to customers as claims about their own site, so a wrong answer
 * here is worse than no answer.
 */
import { describe, expect, it } from "vitest";
import {
  allowedShareOf,
  evaluateBotAccess,
  runAccessCheck,
  validateLlmsTxt,
  type BotProbeResult,
} from "../../../../src/domain/crawl/access-check.js";
import { AI_BOTS } from "../../../../src/domain/crawl/ai-bots.js";
import { EMPTY_ROBOTS, parseRobotsTxt } from "../../../../src/domain/crawl/robots.js";

const okProbes: readonly BotProbeResult[] = AI_BOTS.map((bot) => ({
  botId: bot.id,
  status: 200,
  baselineStatus: 200,
}));

describe("fully open site", () => {
  const findings = evaluateBotAccess(parseRobotsTxt("User-agent: *\nAllow: /"), okProbes);

  it("allows every bot", () => {
    expect(findings).toHaveLength(6);
    expect(findings.every((finding) => finding.allowed)).toBe(true);
  });

  it("offers no fix when nothing is wrong", () => {
    expect(findings.every((finding) => finding.fix === null)).toBe(true);
    expect(findings.every((finding) => finding.blockedBy === null)).toBe(true);
  });

  it("reports no impact for a bot that is allowed", () => {
    // An allowed bot must never carry the "cannot read your pages" copy — that would
    // contradict the "Allowed" verdict shown right next to it.
    expect(findings.every((finding) => finding.impact === null)).toBe(true);
  });

  it("scores 100 on allowed share", () => {
    expect(allowedShareOf(findings)).toBe(100);
  });
});

describe("no robots.txt at all", () => {
  it("treats the site as open rather than inventing a block", () => {
    const findings = evaluateBotAccess(EMPTY_ROBOTS, okProbes);
    expect(findings.every((finding) => finding.allowed)).toBe(true);
    expect(allowedShareOf(findings)).toBe(100);
  });
});

describe("robots-blocked", () => {
  it.each(AI_BOTS.map((bot) => [bot.id] as const))("catches a site-wide block of %s", (botId) => {
    const robots = parseRobotsTxt(`User-agent: ${botId}\nDisallow: /`);
    const findings = evaluateBotAccess(robots, okProbes);

    const blocked = findings.find((finding) => finding.bot === botId);
    expect(blocked?.allowed).toBe(false);
    expect(blocked?.blockedBy).toBe("robots");
    expect(blocked?.evidence).toContain("Disallow: /");
    // The fix is copy-pasteable, and names the bot it is about.
    expect(blocked?.fix).toContain(`User-agent: ${botId}`);
    expect(blocked?.fix).toContain("Allow: /");
    // A blocked bot keeps its plain-language cost — that copy is what motivates the fix.
    expect(blocked?.impact).not.toBeNull();

    // Everyone else is untouched.
    const others = findings.filter((finding) => finding.bot !== botId);
    expect(others.every((finding) => finding.allowed)).toBe(true);
  });

  it("catches the wildcard block that catches everyone", () => {
    const findings = evaluateBotAccess(parseRobotsTxt("User-agent: *\nDisallow: /"), okProbes);
    expect(findings.every((finding) => !finding.allowed)).toBe(true);
    expect(findings.every((finding) => finding.blockedBy === "robots")).toBe(true);
    expect(allowedShareOf(findings)).toBe(0);
  });

  it("weights GPTBot and PerplexityBot double", () => {
    const withoutGpt = evaluateBotAccess(parseRobotsTxt("User-agent: GPTBot\nDisallow: /"), okProbes);
    const withoutCcbot = evaluateBotAccess(parseRobotsTxt("User-agent: CCBot\nDisallow: /"), okProbes);

    // Losing GPTBot costs more of the score than losing CCBot.
    expect(allowedShareOf(withoutGpt)).toBeLessThan(allowedShareOf(withoutCcbot));
  });

  it("reports allowed when a block applies only to a path we do not measure", () => {
    const robots = parseRobotsTxt("User-agent: GPTBot\nDisallow: /admin");
    const findings = evaluateBotAccess(robots, okProbes);
    expect(findings.find((finding) => finding.bot === "GPTBot")?.allowed).toBe(true);
  });
});

describe("CDN-blocked", () => {
  const openRobots = parseRobotsTxt("User-agent: *\nAllow: /");

  it.each([403, 401, 429, 503])(
    "catches an edge refusing the bot with HTTP %i while serving browsers",
    (status) => {
      const probes: BotProbeResult[] = AI_BOTS.map((bot) => ({
        botId: bot.id,
        status: bot.id === "GPTBot" ? status : 200,
        baselineStatus: 200,
      }));

      const findings = evaluateBotAccess(openRobots, probes);
      const gpt = findings.find((finding) => finding.bot === "GPTBot");

      expect(gpt?.allowed).toBe(false);
      expect(gpt?.blockedBy).toBe("cdn");
      expect(gpt?.evidence).toContain(String(status));
      expect(gpt?.fix).toContain("CDN or WAF");
      expect(gpt?.fix).toContain("gptbot");
    },
  );

  it("does not call it a CDN block when the whole site is down", () => {
    const probes: BotProbeResult[] = AI_BOTS.map((bot) => ({
      botId: bot.id,
      status: 503,
      baselineStatus: 503,
    }));
    const findings = evaluateBotAccess(openRobots, probes);
    // A site that is failing for everyone is an outage, not a bot policy.
    expect(findings.every((finding) => finding.allowed)).toBe(true);
  });

  it("does not call it a CDN block for an ordinary 404", () => {
    const probes: BotProbeResult[] = AI_BOTS.map((bot) => ({
      botId: bot.id,
      status: 404,
      baselineStatus: 200,
    }));
    expect(evaluateBotAccess(openRobots, probes).every((finding) => finding.allowed)).toBe(true);
  });

  it("reports robots as the cause when both robots and the edge block", () => {
    const probes: BotProbeResult[] = AI_BOTS.map((bot) => ({
      botId: bot.id,
      status: 403,
      baselineStatus: 200,
    }));
    const findings = evaluateBotAccess(parseRobotsTxt("User-agent: *\nDisallow: /"), probes);
    // robots.txt is the thing the customer can fix first, so it leads.
    expect(findings.every((finding) => finding.blockedBy === "robots")).toBe(true);
  });

  it("tolerates a probe that never completed", () => {
    const probes: BotProbeResult[] = AI_BOTS.map((bot) => ({
      botId: bot.id,
      status: null,
      baselineStatus: 200,
    }));
    expect(evaluateBotAccess(openRobots, probes).every((finding) => finding.allowed)).toBe(true);
  });
});

describe("llms.txt", () => {
  it("reports absence without calling it invalid", () => {
    expect(validateLlmsTxt(null)).toEqual({ present: false, valid: null, issues: [] });
  });

  it("accepts a well-formed file", () => {
    const status = validateLlmsTxt(`# Acme

> Acme builds analytics for AI search.

## Docs
- [Getting started](https://acme.com/docs)
- [Pricing](https://acme.com/pricing)
`);
    expect(status).toMatchObject({ present: true, valid: true });
    expect(status.issues).toEqual([]);
  });

  it("flags an empty file", () => {
    const status = validateLlmsTxt("   ");
    expect(status.valid).toBe(false);
    expect(status.issues[0]).toContain("empty");
  });

  it("flags an HTML 404 page served as llms.txt — the commonest false positive", () => {
    const status = validateLlmsTxt("<!doctype html><html><body>Not found</body></html>");
    expect(status.valid).toBe(false);
    expect(status.issues[0]).toContain("404 page");
  });

  it("flags a missing heading and missing links, with actionable wording", () => {
    const status = validateLlmsTxt("just some prose with no structure at all");
    expect(status.valid).toBe(false);
    expect(status.issues).toHaveLength(2);
    expect(status.issues.join(" ")).toContain("# Your Site Name");
    expect(status.issues.join(" ")).toContain("Markdown links");
  });

  it("accepts a heading anywhere, not only the first line", () => {
    expect(validateLlmsTxt("<!-- generated -->\n# Acme\n- [Docs](https://acme.com/docs)").valid).toBe(
      true,
    );
  });
});

describe("runAccessCheck", () => {
  it("assembles the whole result", () => {
    const result = runAccessCheck({
      robots: parseRobotsTxt("User-agent: GPTBot\nDisallow: /"),
      probes: okProbes,
      llmsTxtContent: "# Acme\n- [Docs](https://acme.com/docs)",
      checkedAt: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(result.bots).toHaveLength(6);
    expect(result.robotsTxtPresent).toBe(true);
    expect(result.llmsTxt.valid).toBe(true);
    expect(result.allowedShare).toBeLessThan(100);
    expect(result.checkedAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("handles the worst case — everything blocked, nothing declared", () => {
    const result = runAccessCheck({
      robots: parseRobotsTxt("User-agent: *\nDisallow: /"),
      probes: okProbes,
      llmsTxtContent: null,
      checkedAt: new Date(),
    });

    expect(result.allowedShare).toBe(0);
    expect(result.llmsTxt.present).toBe(false);
    expect(result.bots.every((finding) => finding.fix !== null)).toBe(true);
  });
});
