/**
 * Reciprocal Rank Fusion (AI-Pipeline §3.3, step 3) — pure, and the whole of the hybrid
 * retriever's ranking logic.
 *
 * RRF fuses ranked lists by *position* rather than by score, which is the point: a cosine
 * distance and a `ts_rank_cd` are not on the same scale and never will be, so any attempt
 * to weight them against each other is a fudge factor pretending to be a parameter. Rank
 * is the one thing both arms agree on.
 *
 * `k` damps the top of each list. With k = 60 the difference between rank 1 and rank 2 is
 * small, so a document both arms rank respectably beats one that a single arm ranks first —
 * which is exactly the behaviour a hybrid retriever exists to get.
 */

/** One arm's ranked output: document ids, best first, no ties. */
export type RankedIds = readonly string[];

export interface FusedResult {
  readonly id: string;
  readonly score: number;
  /** 1-based position in each arm that returned it; absent arms are omitted. */
  readonly ranks: readonly number[];
}

/**
 * Fuses ranked lists.
 *
 * `score(d) = Σ 1 / (k + rank_i(d))` over the arms that returned `d`, ranks being 1-based.
 * Ties break on the id so the same inputs always produce the same order — a fused list
 * that reshuffles between runs would make evidence links point somewhere new each time.
 */
export function reciprocalRankFusion(
  arms: readonly RankedIds[],
  k: number,
): readonly FusedResult[] {
  const scores = new Map<string, { score: number; ranks: number[] }>();

  for (const arm of arms) {
    for (const [index, id] of arm.entries()) {
      const rank = index + 1;
      const existing = scores.get(id);
      const contribution = 1 / (k + rank);
      if (existing === undefined) {
        scores.set(id, { score: contribution, ranks: [rank] });
      } else {
        existing.score += contribution;
        existing.ranks.push(rank);
      }
    }
  }

  return [...scores.entries()]
    .map(([id, entry]) => ({ id, score: entry.score, ranks: entry.ranks }))
    .sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score));
}

/** The fused top `limit`, which becomes the candidate answer context. */
export function fuseTop(arms: readonly RankedIds[], k: number, limit: number): readonly string[] {
  return reciprocalRankFusion(arms, k)
    .slice(0, Math.max(0, limit))
    .map((result) => result.id);
}
