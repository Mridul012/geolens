/**
 * The scoring configuration, v1 (AI-Pipeline §5.1, §3.2, §3.4, §3.5).
 *
 * **Frozen.** Every number here is baked into scores already in the database, and every
 * `scores` row records `scoring_config_version` so a number from six months ago can still
 * be explained. Changing a weight is not an edit — it is a `v2.ts` beside this file, a new
 * version string, and a golden-eval run (Engineering-Rules §15.11).
 *
 * The weights encode a claim about what AI visibility *is*: being cited matters most
 * (35%), because a citation is the outcome; whether your content can be retrieved at all
 * is next (20%), because nothing else matters if it cannot; content quality and topic
 * coverage share 30% as the two halves of "do you have the right material"; and the
 * deterministic technical and trust checks make up the last 15% — small individually, but
 * they are the only components that can never degrade.
 */
import type { ScoringWeights } from "../../domain/scoring/composite.js";
import type {
  QualityWeights,
  TechnicalWeights,
  TrustWeights,
} from "../../domain/scoring/components.js";

export const SCORING_V1: ScoringWeights = Object.freeze({
  version: "scoring.v1",
  weights: Object.freeze({
    citation: 0.35,
    retrievability: 0.2,
    contentQuality: 0.15,
    topicCoverage: 0.15,
    technical: 0.1,
    trust: 0.05,
  }),
  // Below half the evidence, no number is published at all (AI-Pipeline §5.2).
  publicationFloor: 0.5,
});

/** Page quality rubric weights (AI-Pipeline §3.2). */
export const QUALITY_WEIGHTS_V1: QualityWeights = Object.freeze({
  depth: 0.3,
  clarity: 0.2,
  evidence: 0.2,
  freshness: 0.1,
  aiReadability: 0.2,
});

/** Technical sub-weights (AI-Pipeline §3.5). */
export const TECHNICAL_WEIGHTS_V1: TechnicalWeights = Object.freeze({
  botAccess: 0.5,
  structuredData: 0.2,
  llmsTxt: 0.1,
  sitemap: 0.1,
  metaHygiene: 0.1,
});

/** Trust signals, in points out of 100 (AI-Pipeline §3.5). */
export const TRUST_WEIGHTS_V1: TrustWeights = Object.freeze({
  authorBios: 25,
  aboutPage: 15,
  contactPage: 15,
  outboundCitations: 25,
  https: 10,
  datedPolicy: 10,
});

/** How much a decision-stage topic outweighs the others in coverage (AI-Pipeline §3.4). */
export const DECISION_INTENT_MULTIPLIER = 2;

/** Page-quality sampling (AI-Pipeline §3.2). */
export const QUALITY_SAMPLE = Object.freeze({
  maxPages: 30,
  topByInDegree: 10,
  /** Below this share of the sample scoring successfully, the component is null. */
  minScoredShare: 0.6,
  /** Content handed to the rubric, in estimated tokens. */
  contentTokenBudget: 4_000,
});

export const ACTIVE_SCORING_CONFIG = SCORING_V1;
