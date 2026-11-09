/**
 * Topic coverage maths (AI-Pipeline §3.4) — pure, no LLM call, no database.
 *
 * The shape of the formula is the whole argument: coverage needs *both* a quality signal
 * and a volume signal. One excellent page about a topic is a mention, not coverage; twenty
 * passing references are noise, not coverage. Weighting the best match at 0.6 and the
 * depth at 0.4 means neither alone can reach 100, which is exactly the claim we want a
 * score of 100 to make.
 *
 * The thresholds themselves are versioned in `config/scoring/` — this file owns the
 * arithmetic, never the constants.
 */

/**
 * The knobs the formula turns.
 *
 * The *shape* belongs here with the arithmetic; the *values* live in `config/scoring/`
 * and are versioned there (Engineering-Rules §15.6). Domain is pure and imports nothing
 * outward, so the dependency runs config → domain, never the other way.
 */
export interface CoverageThresholds {
  /** Recorded on every coverage block, so a stored number can be traced to its rules. */
  readonly version: string;
  /** Cosine similarity at which a chunk counts as being *about* a topic. */
  readonly matchThreshold: number;
  /** Similarity mapped to 0 in the quality term — below this, a match is noise. */
  readonly simFloor: number;
  /** Width of the quality ramp: `simFloor + simRange` is where quality saturates. */
  readonly simRange: number;
  /** Matching chunks at which the volume term saturates. */
  readonly depthSaturation: number;
  /** Weight on "is the best match strong" versus "is there enough of it". */
  readonly qualityWeight: number;
  readonly depthWeight: number;
  /** A competitor at or above this, and you at or below `ownAbsentAtMost`, is a gap. */
  readonly competitorStrongAtLeast: number;
  readonly ownAbsentAtMost: number;
  /** Chunk ids stored as evidence per topic. */
  readonly evidenceChunks: number;
}

/** What the similarity query reports for one topic against one crawl's chunks. */
export interface TopicMatchStats {
  readonly topicId: string;
  /** Best cosine similarity across every chunk in the crawl; null when there are none. */
  readonly maxSimilarity: number | null;
  /** Chunks at or above the match threshold. */
  readonly depthChunks: number;
  /** Chunk ids behind the score, strongest first. */
  readonly evidenceChunkIds: readonly string[];
}

export interface TopicCoverageResult {
  readonly topicId: string;
  readonly coverageScore: number;
  readonly depthChunks: number;
  readonly maxSimilarity: number | null;
  readonly evidenceChunkIds: readonly string[];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Cosine similarity of two equal-length vectors.
 *
 * Postgres computes this for the real corpus (pgvector's `<=>` over an indexed scan is
 * orders of magnitude faster than pulling 3,000 vectors into Node). This exists so the
 * formula is testable against hand-computed fixtures, and for the handful of in-memory
 * comparisons that never touch the database.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

/** How strong the single best match is, mapped onto 0–1. */
export function normalizedTopSimilarity(
  maxSimilarity: number | null,
  thresholds: CoverageThresholds,
): number {
  if (maxSimilarity === null) return 0;
  return clamp((maxSimilarity - thresholds.simFloor) / thresholds.simRange, 0, 1);
}

/** How much content stands behind the topic, mapped onto 0–1. */
export function depthFactor(depthChunks: number, thresholds: CoverageThresholds): number {
  return Math.min(1, Math.max(0, depthChunks) / thresholds.depthSaturation);
}

/** 0–100 for one topic against one crawl's corpus. */
export function coverageScore(
  stats: Pick<TopicMatchStats, "maxSimilarity" | "depthChunks">,
  thresholds: CoverageThresholds,
): number {
  const quality = normalizedTopSimilarity(stats.maxSimilarity, thresholds);
  const depth = depthFactor(stats.depthChunks, thresholds);
  const combined = thresholds.qualityWeight * quality + thresholds.depthWeight * depth;
  return Math.round(100 * Math.min(1, combined));
}

export function scoreTopics(
  stats: readonly TopicMatchStats[],
  thresholds: CoverageThresholds,
): readonly TopicCoverageResult[] {
  return stats.map((topic) => ({
    topicId: topic.topicId,
    coverageScore: coverageScore(topic, thresholds),
    depthChunks: topic.depthChunks,
    maxSimilarity: topic.maxSimilarity,
    evidenceChunkIds: topic.evidenceChunkIds.slice(0, thresholds.evidenceChunks),
  }));
}

export interface CoverageComparison {
  readonly topicId: string;
  readonly label: string;
  readonly ownCoverage: number | null;
  readonly ownDepth: number | null;
  readonly competitorCoverage: number | null;
  readonly gap: number | null;
  readonly missing: boolean;
}

/**
 * A topic is *missing* when a competitor covers it well and we effectively do not
 * (AI-Pipeline §3.4, fixed definition).
 *
 * Deliberately asymmetric and deliberately strict: "they have a bit more than us" is not a
 * finding a user can act on, and a recommendations engine fed on near-ties produces a list
 * nobody reads.
 */
export function isMissingTopic(
  ownCoverage: number | null,
  competitorCoverage: number | null,
  thresholds: CoverageThresholds,
): boolean {
  if (competitorCoverage === null) return false;
  if (competitorCoverage < thresholds.competitorStrongAtLeast) return false;
  return (ownCoverage ?? 0) <= thresholds.ownAbsentAtMost;
}

export interface CoverageInput {
  readonly topicId: string;
  readonly label: string;
  readonly ownCoverage: number | null;
  readonly ownDepth: number | null;
  readonly competitorCoverage: number | null;
}

/**
 * Builds the comparison rows the coverage endpoint serves, ranked so the biggest gaps
 * lead. Ties break on label, so the same data always renders in the same order.
 */
export function compareCoverage(
  rows: readonly CoverageInput[],
  thresholds: CoverageThresholds,
): readonly CoverageComparison[] {
  return rows
    .map((row) => ({
      topicId: row.topicId,
      label: row.label,
      ownCoverage: row.ownCoverage,
      ownDepth: row.ownDepth,
      competitorCoverage: row.competitorCoverage,
      gap:
        row.competitorCoverage === null ? null : row.competitorCoverage - (row.ownCoverage ?? 0),
      missing: isMissingTopic(row.ownCoverage, row.competitorCoverage, thresholds),
    }))
    .sort((a, b) => {
      if (a.missing !== b.missing) return a.missing ? -1 : 1;
      // A topic with no competitor data is not a gap of zero — it is an unknown, and it
      // sorts below every topic we can actually compare.
      if ((a.gap === null) !== (b.gap === null)) return a.gap === null ? 1 : -1;
      if (a.gap !== null && b.gap !== null && a.gap !== b.gap) return b.gap - a.gap;
      return a.label.localeCompare(b.label);
    });
}
