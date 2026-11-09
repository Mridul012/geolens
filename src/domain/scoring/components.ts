/**
 * The deterministic component scores (AI-Pipeline §3.4, §3.5) — pure.
 *
 * `technical` and `trust` never degrade, and that is deliberate rather than convenient:
 * they need no external call, so every completed crawl produces at least a partial score.
 * A site whose model provider was down still sees *something* it can act on.
 *
 * Everything here is a weighted sum of things we either observed or did not. There is no
 * model output in this file, which is the point — a page can lie about itself in prose,
 * but it cannot lie about whether it has a canonical tag.
 */
import type { TopicBuyerIntent } from "./intent.js";

/** Sub-weights for the composite's deterministic components. */
export interface TechnicalWeights {
  readonly botAccess: number;
  readonly structuredData: number;
  readonly llmsTxt: number;
  readonly sitemap: number;
  readonly metaHygiene: number;
}

export interface TrustWeights {
  readonly authorBios: number;
  readonly aboutPage: number;
  readonly contactPage: number;
  readonly outboundCitations: number;
  readonly https: number;
  readonly datedPolicy: number;
}

export interface QualityWeights {
  readonly depth: number;
  readonly clarity: number;
  readonly evidence: number;
  readonly freshness: number;
  readonly aiReadability: number;
}

function clamp(value: number, low = 0, high = 100): number {
  return Math.min(high, Math.max(low, value));
}

/** A share in [0,1] from a count, treating "no denominator" as zero rather than NaN. */
function share(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.min(1, Math.max(0, part / whole));
}

// ── Content quality ─────────────────────────────────────────────────────────

export interface PageQualityRubric {
  readonly depth: number;
  readonly clarity: number;
  readonly evidence: number;
  readonly freshness: number;
  readonly aiReadability: number;
}

/** One page's quality score (AI-Pipeline §3.2 aggregate). */
export function pageQualityScore(
  rubric: PageQualityRubric,
  weights: QualityWeights,
): number {
  return Math.round(
    weights.depth * clamp(rubric.depth) +
      weights.clarity * clamp(rubric.clarity) +
      weights.evidence * clamp(rubric.evidence) +
      weights.freshness * clamp(rubric.freshness) +
      weights.aiReadability * clamp(rubric.aiReadability),
  );
}

export interface ContentQualityResult {
  readonly score: number | null;
  readonly pagesScored: number;
  readonly pagesSampled: number;
  readonly scoredShare: number;
}

/**
 * The component score: the mean page score, but only if enough pages were scored.
 *
 * Below the threshold the component is null rather than a mean of whatever happened to
 * succeed — a score built from four pages of a thirty-page sample is not the same
 * measurement as one built from thirty, and presenting them identically would be the
 * quiet kind of dishonesty this codebase is trying to avoid.
 */
export function contentQualityScore(
  pageScores: readonly number[],
  pagesSampled: number,
  minScoredShare: number,
): ContentQualityResult {
  const scoredShare = share(pageScores.length, pagesSampled);
  if (pageScores.length === 0 || scoredShare < minScoredShare) {
    return { score: null, pagesScored: pageScores.length, pagesSampled, scoredShare };
  }
  const mean = pageScores.reduce((sum, score) => sum + clamp(score), 0) / pageScores.length;
  return {
    score: Math.round(mean),
    pagesScored: pageScores.length,
    pagesSampled,
    scoredShare,
  };
}

// ── Topic coverage ──────────────────────────────────────────────────────────

export interface TopicCoverageEntry {
  readonly coverageScore: number;
  readonly buyerIntent: TopicBuyerIntent | null;
}

/**
 * Mean coverage, with decision-stage topics counted twice (AI-Pipeline §3.4).
 *
 * A buyer comparing pricing is closer to a purchase than one reading a problem explainer,
 * so being invisible on a decision topic costs more. A null intent takes the base weight:
 * user-added topics carry no stage, and guessing one on their behalf would put a number
 * in the score that nobody asserted (ADR 0004).
 */
export function topicCoverageScore(
  topics: readonly TopicCoverageEntry[],
  decisionMultiplier: number,
): number | null {
  if (topics.length === 0) return null;

  let weighted = 0;
  let totalWeight = 0;
  for (const topic of topics) {
    const weight = topic.buyerIntent === "decision" ? decisionMultiplier : 1;
    weighted += clamp(topic.coverageScore) * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? null : Math.round(weighted / totalWeight);
}

// ── Technical ───────────────────────────────────────────────────────────────

export interface TechnicalFacts {
  /** 0–100: share of the six AI bots allowed, GPTBot and PerplexityBot double-weighted. */
  readonly botAccessShare: number;
  readonly pagesWithStructuredData: number;
  readonly pagesTotal: number;
  readonly llmsTxtPresent: boolean;
  readonly llmsTxtValid: boolean | null;
  readonly sitemapPresent: boolean;
  readonly pagesWithCanonical: number;
  readonly pagesWithMetaDescription: number;
  readonly pagesWithTitle: number;
}

export interface TechnicalResult {
  readonly score: number;
  readonly parts: Readonly<Record<keyof TechnicalWeights, number>>;
}

/**
 * The technical component (AI-Pipeline §3.5).
 *
 * Bot access dominates at 50% because it is binary and total: a site that blocks GPTBot is
 * invisible to a large share of AI answers no matter how good its content is. That is the
 * product's fastest "aha", and the score says so.
 */
export function technicalScore(
  facts: TechnicalFacts,
  weights: TechnicalWeights,
): TechnicalResult {
  const hygiene =
    (share(facts.pagesWithCanonical, facts.pagesTotal) +
      share(facts.pagesWithMetaDescription, facts.pagesTotal) +
      share(facts.pagesWithTitle, facts.pagesTotal)) /
    3;

  const parts = {
    botAccess: clamp(facts.botAccessShare),
    structuredData: 100 * share(facts.pagesWithStructuredData, facts.pagesTotal),
    // Present but invalid earns nothing: a malformed llms.txt is not a half-measure, it is
    // a file no consumer can read.
    llmsTxt: facts.llmsTxtPresent && facts.llmsTxtValid === true ? 100 : 0,
    sitemap: facts.sitemapPresent ? 100 : 0,
    metaHygiene: 100 * hygiene,
  };

  const score = Math.round(
    weights.botAccess * parts.botAccess +
      weights.structuredData * parts.structuredData +
      weights.llmsTxt * parts.llmsTxt +
      weights.sitemap * parts.sitemap +
      weights.metaHygiene * parts.metaHygiene,
  );

  return { score: clamp(score), parts };
}

// ── Trust ───────────────────────────────────────────────────────────────────

export interface TrustFacts {
  readonly contentPages: number;
  readonly pagesWithAuthor: number;
  readonly hasAboutPage: boolean;
  readonly hasContactPage: boolean;
  readonly pagesWithOutboundCitations: number;
  readonly httpsValid: boolean;
  readonly hasDatedPolicyPage: boolean;
}

export interface TrustResult {
  readonly score: number;
  readonly parts: Readonly<Record<keyof TrustWeights, boolean>>;
}

/** Share of content pages that must cite outward before the signal counts. */
const OUTBOUND_CITATION_THRESHOLD = 0.3;
/** Share of content pages that must name an author before the signal counts. */
const AUTHOR_BIO_THRESHOLD = 0.3;

/**
 * The trust component (AI-Pipeline §3.5) — six present-or-absent signals.
 *
 * Deliberately binary. These are the things a model looks for to decide whether a source is
 * worth citing, and "40% of the way to having an about page" is not a state that exists.
 */
export function trustScore(facts: TrustFacts, weights: TrustWeights): TrustResult {
  const parts = {
    authorBios: share(facts.pagesWithAuthor, facts.contentPages) >= AUTHOR_BIO_THRESHOLD,
    aboutPage: facts.hasAboutPage,
    contactPage: facts.hasContactPage,
    outboundCitations:
      share(facts.pagesWithOutboundCitations, facts.contentPages) >= OUTBOUND_CITATION_THRESHOLD,
    https: facts.httpsValid,
    datedPolicy: facts.hasDatedPolicyPage,
  };

  const score =
    (parts.authorBios ? weights.authorBios : 0) +
    (parts.aboutPage ? weights.aboutPage : 0) +
    (parts.contactPage ? weights.contactPage : 0) +
    (parts.outboundCitations ? weights.outboundCitations : 0) +
    (parts.https ? weights.https : 0) +
    (parts.datedPolicy ? weights.datedPolicy : 0);

  return { score: clamp(Math.round(score)), parts };
}
