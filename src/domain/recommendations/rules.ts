/**
 * The deterministic recommendation rules (docs/Architecture.md §Layer 1, PRD FR-9.1).
 *
 * Rules run before the model and are never overridden by it. That ordering is the whole
 * design: a rule is instant, free, and *always correct* — "GPTBot is disallowed in your
 * robots.txt" is not an opinion — whereas a model's suggestion is a judgement that might
 * be generic filler. Leading with rules means the list is never empty and never wrong at
 * the top, which is what makes the rest of it worth reading.
 *
 * Pure: facts in, findings out. Every rule states what it saw, so the card can show the
 * user the evidence rather than asking them to trust it.
 */

/** What the crawl observed. Assembled by the application layer; never fetched here. */
export interface SiteFindings {
  readonly crawlId: string;
  readonly pagesTotal: number;
  /** Bot access, as the M8 check reports it. */
  readonly blockedBots: ReadonlyArray<{
    readonly bot: string;
    readonly blockedBy: "robots" | "cdn" | null;
    readonly fix: string | null;
  }>;
  readonly llmsTxtPresent: boolean;
  readonly llmsTxtValid: boolean | null;
  readonly sitemapPresent: boolean;
  readonly pagesWithStructuredData: number;
  readonly pagesMissingMetaDescription: readonly PageRef[];
  readonly thinPages: readonly PageRef[];
  readonly stalePages: readonly PageRef[];
  readonly orphanPages: readonly PageRef[];
  /** Topics a competitor covers well and this site does not (M10). */
  readonly missingTopics: ReadonlyArray<{ readonly label: string; readonly gap: number }>;
  /** Buyer questions the site's own content could not answer (M11). */
  readonly unansweredQuestions: ReadonlyArray<{
    readonly question: string;
    readonly missingElement: string | null;
  }>;
}

export interface PageRef {
  readonly snapshotId: string;
  readonly url: string;
  readonly wordCount: number;
}

export type RecPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface RuleFinding {
  /** Stable across versions — it is half the dedupe fingerprint. */
  readonly ruleKey: string;
  readonly title: string;
  readonly body: string;
  readonly priority: RecPriority;
  /** 1–5. Impact is how much fixing this moves visibility. */
  readonly impact: number;
  /** 1–5. Difficulty is how much work it is, not how technical it sounds. */
  readonly difficulty: number;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface RuleThresholds {
  /** Below this word count a page is thin. */
  readonly thinWords: number;
  /** Pages older than this, on a topic that moves, are stale. */
  readonly staleDays: number;
  /** Share of pages that must carry JSON-LD before the schema rule stays quiet. */
  readonly structuredDataShare: number;
  /** How many pages a card names before it says "and N more". */
  readonly evidencePages: number;
  /** Gaps and questions worth raising as their own card. */
  readonly topicGapLimit: number;
  readonly questionLimit: number;
}

export const RULE_THRESHOLDS_V1: RuleThresholds = Object.freeze({
  thinWords: 200,
  staleDays: 540,
  structuredDataShare: 0.5,
  evidencePages: 10,
  topicGapLimit: 5,
  questionLimit: 5,
});

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

function refs(pages: readonly PageRef[], limit: number): Readonly<Record<string, unknown>> {
  return {
    snapshotIds: pages.slice(0, limit).map((page) => page.snapshotId),
    urls: pages.slice(0, limit).map((page) => page.url),
    total: pages.length,
  };
}

/**
 * Blocked AI crawlers.
 *
 * The product's single most consequential finding, and the one a customer can most often
 * fix in five minutes — so it is CRITICAL, maximum impact, minimum difficulty. Everything
 * else on the list is irrelevant while this is true.
 */
function blockedBotsRule(findings: SiteFindings): RuleFinding | null {
  if (findings.blockedBots.length === 0) return null;

  const names = findings.blockedBots.map((bot) => bot.bot);
  const byRobots = findings.blockedBots.filter((bot) => bot.blockedBy === "robots");

  return {
    ruleKey: "blocked-ai-crawlers",
    title: `Unblock ${names.length} AI ${plural(names.length, "crawler")}`,
    body:
      `${names.join(", ")} cannot read your site, so nothing you publish can appear in ` +
      `their answers. ` +
      (byRobots.length > 0
        ? `${byRobots.length} of them ${plural(byRobots.length, "is", "are")} blocked in ` +
          `robots.txt, which is a one-line change. `
        : "") +
      `This is the highest-leverage fix available to you.`,
    priority: "CRITICAL",
    impact: 5,
    difficulty: byRobots.length === findings.blockedBots.length ? 1 : 3,
    evidence: {
      checkKeys: names,
      blockedBy: findings.blockedBots.map((bot) => bot.blockedBy),
      fixes: findings.blockedBots.flatMap((bot) => (bot.fix === null ? [] : [bot.fix])),
    },
  };
}

/** A missing or malformed llms.txt. Cheap to add, and increasingly read. */
function llmsTxtRule(findings: SiteFindings): RuleFinding | null {
  if (findings.llmsTxtPresent && findings.llmsTxtValid !== false) return null;

  const invalid = findings.llmsTxtPresent && findings.llmsTxtValid === false;
  return {
    ruleKey: invalid ? "llms-txt-invalid" : "llms-txt-missing",
    title: invalid ? "Fix your llms.txt" : "Add an llms.txt",
    body: invalid
      ? "Your llms.txt exists but does not parse, so any assistant that fetches it gets nothing. Fixing the format costs minutes."
      : "An llms.txt tells AI assistants which parts of your site matter and how to describe you. It is a single markdown file at your root.",
    priority: "MEDIUM",
    impact: 2,
    difficulty: 1,
    evidence: { checkKeys: ["llms.txt"], present: findings.llmsTxtPresent },
  };
}

/** No sitemap: discovery falls back to link-following, which misses whatever is unlinked. */
function sitemapRule(findings: SiteFindings): RuleFinding | null {
  if (findings.sitemapPresent) return null;
  return {
    ruleKey: "sitemap-missing",
    title: "Publish a sitemap",
    body:
      "We found no sitemap, so crawlers — ours and theirs — have to discover your pages by " +
      "following links. Anything not linked from another page is effectively invisible.",
    priority: "MEDIUM",
    impact: 3,
    difficulty: 1,
    evidence: { checkKeys: ["sitemap.xml"] },
  };
}

/** Structured data on too few pages. */
function structuredDataRule(
  findings: SiteFindings,
  thresholds: RuleThresholds,
): RuleFinding | null {
  if (findings.pagesTotal === 0) return null;
  const share = findings.pagesWithStructuredData / findings.pagesTotal;
  if (share >= thresholds.structuredDataShare) return null;

  const missing = findings.pagesTotal - findings.pagesWithStructuredData;
  return {
    ruleKey: "structured-data-missing",
    title: "Add schema.org markup to your key pages",
    body:
      `${missing} of ${findings.pagesTotal} pages carry no JSON-LD. Structured data is how ` +
      `a machine knows what a page *is* — a product, an article, an FAQ — rather than ` +
      `guessing from prose.`,
    priority: share === 0 ? "HIGH" : "MEDIUM",
    impact: 3,
    difficulty: 3,
    evidence: {
      checkKeys: ["structured-data"],
      pagesWithStructuredData: findings.pagesWithStructuredData,
      pagesTotal: findings.pagesTotal,
    },
  };
}

/** Pages too short to answer anything. */
function thinContentRule(findings: SiteFindings, thresholds: RuleThresholds): RuleFinding | null {
  if (findings.thinPages.length === 0) return null;
  return {
    ruleKey: "thin-content",
    title: `Expand ${findings.thinPages.length} thin ${plural(findings.thinPages.length, "page")}`,
    body:
      `These pages fall under ${thresholds.thinWords} words. A retriever that pulls one of ` +
      `them back has nothing to answer with, so they cost you a citation opportunity ` +
      `without giving anything back.`,
    priority: findings.thinPages.length > findings.pagesTotal / 2 ? "HIGH" : "MEDIUM",
    impact: 3,
    difficulty: 4,
    evidence: refs(findings.thinPages, thresholds.evidencePages),
  };
}

/** Content that has not been touched in a long time. */
function staleContentRule(findings: SiteFindings, thresholds: RuleThresholds): RuleFinding | null {
  if (findings.stalePages.length === 0) return null;
  return {
    ruleKey: "stale-content",
    title: `Refresh ${findings.stalePages.length} stale ${plural(findings.stalePages.length, "page")}`,
    body:
      `Nothing on these pages has changed in over ${Math.round(thresholds.staleDays / 365)} ` +
      `years, and none of them says when it was last reviewed. Assistants weigh currency, ` +
      `and so do readers.`,
    priority: "LOW",
    impact: 2,
    difficulty: 3,
    evidence: refs(findings.stalePages, thresholds.evidencePages),
  };
}

/** Pages nothing links to. */
function orphanPagesRule(findings: SiteFindings, thresholds: RuleThresholds): RuleFinding | null {
  if (findings.orphanPages.length === 0) return null;
  return {
    ruleKey: "orphan-pages",
    title: `Link to ${findings.orphanPages.length} orphaned ${plural(findings.orphanPages.length, "page")}`,
    body:
      "No other page on your site links to these. Crawlers reach them only through the " +
      "sitemap, and readers usually not at all — which makes them the cheapest content " +
      "you own to make visible.",
    priority: "MEDIUM",
    impact: 2,
    difficulty: 2,
    evidence: refs(findings.orphanPages, thresholds.evidencePages),
  };
}

/** Missing page descriptions. */
function metaDescriptionRule(
  findings: SiteFindings,
  thresholds: RuleThresholds,
): RuleFinding | null {
  if (findings.pagesMissingMetaDescription.length === 0) return null;
  return {
    ruleKey: "meta-description-missing",
    title: `Write descriptions for ${findings.pagesMissingMetaDescription.length} ${plural(findings.pagesMissingMetaDescription.length, "page")}`,
    body:
      "A meta description is the one sentence you get to write about a page yourself. " +
      "Without it, anything summarising your page invents that sentence for you.",
    priority: "LOW",
    impact: 2,
    difficulty: 2,
    evidence: refs(findings.pagesMissingMetaDescription, thresholds.evidencePages),
  };
}

/** Subjects a competitor owns and this site does not. */
function missingTopicsRule(
  findings: SiteFindings,
  thresholds: RuleThresholds,
): RuleFinding | null {
  if (findings.missingTopics.length === 0) return null;
  const top = findings.missingTopics.slice(0, thresholds.topicGapLimit);

  return {
    ruleKey: "missing-topics",
    title: `Cover ${top.length} ${plural(top.length, "topic")} your competitor owns`,
    body:
      `A competitor has substantial content on ${top.map((topic) => topic.label).join(", ")} ` +
      `and you have effectively none. These are the questions where they get cited and you ` +
      `are not in the running.`,
    priority: "HIGH",
    impact: 4,
    difficulty: 4,
    evidence: {
      topicLabels: top.map((topic) => topic.label),
      gaps: top.map((topic) => topic.gap),
    },
  };
}

/** Buyer questions the site's own content cannot answer. */
function unansweredQuestionsRule(
  findings: SiteFindings,
  thresholds: RuleThresholds,
): RuleFinding | null {
  if (findings.unansweredQuestions.length === 0) return null;
  const top = findings.unansweredQuestions.slice(0, thresholds.questionLimit);

  return {
    ruleKey: "unanswered-buyer-questions",
    title: `Answer ${top.length} buyer ${plural(top.length, "question")} your site does not`,
    body:
      `We asked your own content the questions your buyers ask and it could not answer ` +
      `these. Each one is a page you could write today, and we know exactly what is missing.`,
    priority: "HIGH",
    impact: 4,
    difficulty: 3,
    evidence: {
      questions: top.map((item) => item.question),
      missingElements: top.map((item) => item.missingElement),
    },
  };
}

const RULES = [
  blockedBotsRule,
  missingTopicsRule,
  unansweredQuestionsRule,
  structuredDataRule,
  thinContentRule,
  orphanPagesRule,
  llmsTxtRule,
  sitemapRule,
  metaDescriptionRule,
  staleContentRule,
] as const;

/**
 * Every rule that fires, in a stable order.
 *
 * Order here is not the display order — ranking handles that — it is only so the same
 * findings always produce the same list, which is what makes the dedupe fingerprints
 * stable across crawls.
 */
export function evaluateRules(
  findings: SiteFindings,
  thresholds: RuleThresholds = RULE_THRESHOLDS_V1,
): readonly RuleFinding[] {
  return RULES.flatMap((rule) => {
    const finding = rule(findings, thresholds);
    return finding === null ? [] : [finding];
  });
}

/** Every rule key this version can emit — the golden evals assert against this. */
export const RULE_KEYS: readonly string[] = [
  "blocked-ai-crawlers",
  "missing-topics",
  "unanswered-buyer-questions",
  "structured-data-missing",
  "thin-content",
  "orphan-pages",
  "llms-txt-missing",
  "llms-txt-invalid",
  "sitemap-missing",
  "meta-description-missing",
  "stale-content",
];
