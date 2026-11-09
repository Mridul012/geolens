/**
 * The AI crawlers this product reports on (PRD FR-4.1, docs/Architecture.md Stage 2).
 *
 * This is the cheapest high-value feature in the product: a site can go from "why is our
 * score low" to "we've been blocking GPTBot for a year" in one crawl. That makes the
 * verdicts customer-facing claims, so the evaluation is pure and exhaustively tested — a
 * false "blocked" is a support ticket, and a false "allowed" is the product failing at the
 * one thing it promises.
 *
 * Weights feed `score_technical` (AI-Pipeline §3.5): GPTBot and PerplexityBot count double
 * because they drive the engines the product actually measures.
 */

export type AiBotId =
  | "GPTBot"
  | "ClaudeBot"
  | "PerplexityBot"
  | "Google-Extended"
  | "CCBot"
  | "Bytespider";

export interface AiBotProfile {
  readonly id: AiBotId;
  /** The token to match in robots.txt. */
  readonly userAgentToken: string;
  /** Full UA string, for the CDN-block probe. */
  readonly userAgent: string;
  readonly operator: string;
  /** What blocking this bot actually costs the customer, in plain language. */
  readonly impact: string;
  /** Relative weight in the technical score (AI-Pipeline §3.5). */
  readonly weight: number;
}

export const AI_BOTS: readonly AiBotProfile[] = Object.freeze([
  {
    id: "GPTBot",
    userAgentToken: "gptbot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",
    operator: "OpenAI",
    impact:
      "ChatGPT cannot read your pages, so it can neither summarise nor cite you when someone asks about your category.",
    weight: 2,
  },
  {
    id: "PerplexityBot",
    userAgentToken: "perplexitybot",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot",
    operator: "Perplexity",
    impact:
      "Perplexity cannot index your pages, so you cannot appear as a source in its answers.",
    weight: 2,
  },
  {
    id: "ClaudeBot",
    userAgentToken: "claudebot",
    userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com",
    operator: "Anthropic",
    impact: "Claude cannot read your pages when answering questions about your category.",
    weight: 1,
  },
  {
    id: "Google-Extended",
    userAgentToken: "google-extended",
    userAgent: "Mozilla/5.0 (compatible; Google-Extended/1.0)",
    operator: "Google",
    impact:
      "Gemini and Google's AI Overviews cannot use your content. Note this does not affect ordinary Google Search ranking.",
    weight: 1,
  },
  {
    id: "CCBot",
    userAgentToken: "ccbot",
    userAgent: "CCBot/2.0 (https://commoncrawl.org/faq/)",
    operator: "Common Crawl",
    impact:
      "Common Crawl feeds many models' training data. Blocking it removes you from a corpus much of the field builds on.",
    weight: 1,
  },
  {
    id: "Bytespider",
    userAgentToken: "bytespider",
    userAgent: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
    operator: "ByteDance",
    impact: "ByteDance's AI products cannot read your pages.",
    weight: 1,
  },
]);

export const TOTAL_BOT_WEIGHT: number = AI_BOTS.reduce((sum, bot) => sum + bot.weight, 0);

export function botById(id: AiBotId): AiBotProfile {
  const bot = AI_BOTS.find((candidate) => candidate.id === id);
  if (bot === undefined) throw new Error(`Unknown AI bot: ${id}`);
  return bot;
}
