/**
 * The AI crawler access verdict — pure (PRD FR-4, docs/Architecture.md Stage 2).
 *
 * Takes the evidence gathered by infrastructure (a robots.txt, an llms.txt, per-bot probe
 * responses) and decides what to tell the customer, including the copy-paste fix. Keeping
 * the judgement here rather than in the fetcher means the whole fixture matrix — open,
 * robots-blocked, CDN-blocked, llms.txt present/absent/invalid — is testable without a
 * network.
 */
import { isPathAllowed, type RobotsTxt } from "./robots.js";
import { AI_BOTS, TOTAL_BOT_WEIGHT, type AiBotId, type AiBotProfile } from "./ai-bots.js";

export type BlockedBy = "robots" | "cdn" | null;

export interface BotProbeResult {
  readonly botId: AiBotId;
  /** HTTP status the site returned to this bot's user agent, or null if unreachable. */
  readonly status: number | null;
  /** Status returned to an ordinary browser UA, for comparison. */
  readonly baselineStatus: number | null;
}

export interface BotFinding {
  readonly bot: AiBotId;
  readonly operator: string;
  readonly allowed: boolean;
  readonly blockedBy: BlockedBy;
  /** The robots.txt line responsible, when that is the cause. */
  readonly evidence: string | null;
  /** What blocking this bot costs the customer, in plain language; null when it is allowed. */
  readonly impact: string | null;
  /** Copy-paste remediation, or null when nothing is wrong. */
  readonly fix: string | null;
}

export interface LlmsTxtStatus {
  readonly present: boolean;
  /** null when absent — "invalid" would be a false claim about a file that is not there. */
  readonly valid: boolean | null;
  readonly issues: readonly string[];
}

export interface AccessCheckResult {
  readonly bots: readonly BotFinding[];
  readonly llmsTxt: LlmsTxtStatus;
  readonly robotsTxtPresent: boolean;
  /** 0–100, weighted by bot importance — the input to `score_technical`. */
  readonly allowedShare: number;
  readonly checkedAt: string;
}

/**
 * A CDN or WAF block looks different from a robots block: the site answers a browser
 * normally and refuses the bot's user agent. 401/403/429 and the Cloudflare-family 5xx
 * codes are the shapes that mean "you specifically are not welcome".
 */
function isCdnBlocked(probe: BotProbeResult): boolean {
  if (probe.status === null) return false;
  const baselineOk = probe.baselineStatus !== null && probe.baselineStatus < 400;
  if (!baselineOk) return false; // The whole site is unhappy; not a bot-specific block.
  return probe.status === 401 || probe.status === 403 || probe.status === 429 || probe.status === 503;
}

function robotsFix(bot: AiBotProfile): string {
  return [
    `# Allow ${bot.operator}'s crawler in robots.txt`,
    `User-agent: ${bot.id}`,
    `Allow: /`,
  ].join("\n");
}

function cdnFix(bot: AiBotProfile): string {
  return [
    `Your CDN or WAF is refusing ${bot.id}, not your robots.txt.`,
    ``,
    `Cloudflare: Security → Bots → disable "AI Scrapers and Crawlers", or add a`,
    `WAF skip rule for user agents containing "${bot.userAgentToken}".`,
    ``,
    `Other providers: allowlist the user agent`,
    `  ${bot.userAgent}`,
  ].join("\n");
}

/** Every AI bot's verdict, from robots.txt and the probe results. */
export function evaluateBotAccess(
  robots: RobotsTxt,
  probes: readonly BotProbeResult[],
): readonly BotFinding[] {
  return AI_BOTS.map((bot) => {
    const verdict = isPathAllowed(robots, bot.userAgentToken, "/");
    const probe = probes.find((candidate) => candidate.botId === bot.id);

    if (!verdict.allowed) {
      const rule = verdict.matchedRule;
      return {
        bot: bot.id,
        operator: bot.operator,
        allowed: false,
        blockedBy: "robots" as const,
        evidence:
          rule === null
            ? null
            : `robots.txt — User-agent: ${verdict.matchedAgent ?? "*"} / ${rule.type === "disallow" ? "Disallow" : "Allow"}: ${rule.path}`,
        impact: bot.impact,
        fix: robotsFix(bot),
      };
    }

    if (probe !== undefined && isCdnBlocked(probe)) {
      // robots.txt says yes and the edge says no — the most confusing failure a site owner
      // can have, because nothing in their own config looks wrong.
      return {
        bot: bot.id,
        operator: bot.operator,
        allowed: false,
        blockedBy: "cdn" as const,
        evidence: `Your site returned HTTP ${probe.status} to ${bot.id} but ${probe.baselineStatus} to a browser.`,
        impact: bot.impact,
        fix: cdnFix(bot),
      };
    }

    return {
      bot: bot.id,
      operator: bot.operator,
      allowed: true,
      blockedBy: null,
      evidence: null,
      impact: null,
      fix: null,
    };
  });
}

/** Weighted share of bots allowed, 0–100 (AI-Pipeline §3.5). */
export function allowedShareOf(findings: readonly BotFinding[]): number {
  const allowedWeight = findings.reduce((sum, finding) => {
    if (!finding.allowed) return sum;
    const bot = AI_BOTS.find((candidate) => candidate.id === finding.bot);
    return sum + (bot?.weight ?? 0);
  }, 0);
  return Math.round((allowedWeight / TOTAL_BOT_WEIGHT) * 100);
}

/**
 * Validates an llms.txt (PRD FR-4.2).
 *
 * The convention is a Markdown file at the site root: an H1 naming the site, optional
 * prose, then link sections. Validation is deliberately lenient — the spec is young and a
 * pedantic failure would teach customers to ignore the finding — but it does catch the
 * mistakes that make the file useless: no heading, no links, or HTML served by mistake.
 */
export function validateLlmsTxt(content: string | null): LlmsTxtStatus {
  if (content === null) return { present: false, valid: null, issues: [] };

  const issues: string[] = [];
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return { present: true, valid: false, issues: ["The file is empty."] };
  }
  if (/^\s*<(!doctype|html)/i.test(trimmed)) {
    // A 404 page served with a 200 is the single commonest way this "exists".
    return {
      present: true,
      valid: false,
      issues: ["The file returned HTML, not Markdown — it is probably your 404 page."],
    };
  }
  if (!/^#\s+\S/m.test(trimmed)) {
    issues.push("No H1 heading. Start the file with `# Your Site Name`.");
  }
  if (!/\[[^\]]+\]\([^)]+\)/.test(trimmed)) {
    issues.push("No Markdown links. List your key pages so models know what to read.");
  }

  return { present: true, valid: issues.length === 0, issues };
}

export interface AccessCheckInput {
  readonly robots: RobotsTxt;
  readonly probes: readonly BotProbeResult[];
  readonly llmsTxtContent: string | null;
  readonly checkedAt: Date;
}

export function runAccessCheck(input: AccessCheckInput): AccessCheckResult {
  const bots = evaluateBotAccess(input.robots, input.probes);
  return {
    bots,
    llmsTxt: validateLlmsTxt(input.llmsTxtContent),
    robotsTxtPresent: input.robots.present,
    allowedShare: allowedShareOf(bots),
    checkedAt: input.checkedAt.toISOString(),
  };
}
