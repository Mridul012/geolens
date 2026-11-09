/**
 * Retrievability metrics (AI-Pipeline §3.3) — pure.
 *
 * The claim this score makes is narrow and worth stating precisely: *if this site's own
 * content were chunked and retrieved the way an AI search engine does it, could it answer
 * its own customers' questions?* It is not a measure of writing quality and not a
 * prediction of citations. It is a retrieval simulation, and the number means nothing
 * unless enough questions were actually judged — which is why `judgedShare` is part of the
 * result rather than a footnote.
 */

/** The judge's verdict for one question (AI-Pipeline §3.3, CoverageJudgment). */
export type Answered = "fully" | "partially" | "no";

export interface RetrievabilityThresholds {
  readonly version: string;
  /** Ranked results taken from each retrieval arm before fusion. */
  readonly vectorTopK: number;
  readonly lexicalTopK: number;
  /** Fused results handed to the judge as the candidate answer context. */
  readonly contextChunks: number;
  /** RRF damping constant. */
  readonly rrfK: number;
  /** Credit for a partially answered question. */
  readonly partialCredit: number;
  /** Below this share of questions judged, the component is degraded and scores null. */
  readonly minJudgedShare: number;
  /** Buyer questions requested from the model. */
  readonly minQuestions: number;
  readonly maxQuestions: number;
}

export interface QuestionOutcome {
  readonly question: string;
  readonly topicLabel: string;
  /** Null when the judge could not be reached for this question. */
  readonly answered: Answered | null;
  readonly confidence: number | null;
  readonly missingElement: string | null;
  /** The fused top chunks this verdict was formed on — the evidence trail. */
  readonly chunkIds: readonly string[];
}

export interface RetrievabilityMetrics {
  readonly questionsTotal: number;
  readonly questionsJudged: number;
  /** Fully answered; the headline "we can answer this" count. */
  readonly questionsAnswered: number;
  readonly questionsPartial: number;
  readonly questionsUnanswered: number;
  /** Fraction of questions the judge returned a verdict for. */
  readonly judgedShare: number;
  /** `(fully + partial·credit) / judged`, or null when too few were judged. */
  readonly hitRate: number | null;
  /** `round(100 · hitRate)`, or null. Null means unmeasured, never "bad". */
  readonly score: number | null;
  readonly degraded: boolean;
}

/**
 * Turns per-question verdicts into the component's numbers.
 *
 * The hit rate is over *judged* questions, not over all of them. Dividing by the total
 * would silently punish a site for our judge being unavailable, which would make the score
 * a measure of our uptime rather than of their content.
 */
export function summarise(
  outcomes: readonly QuestionOutcome[],
  thresholds: RetrievabilityThresholds,
): RetrievabilityMetrics {
  const total = outcomes.length;
  const judged = outcomes.filter((outcome) => outcome.answered !== null);
  const fully = judged.filter((outcome) => outcome.answered === "fully").length;
  const partially = judged.filter((outcome) => outcome.answered === "partially").length;
  const none = judged.filter((outcome) => outcome.answered === "no").length;

  const judgedShare = total === 0 ? 0 : judged.length / total;
  const enough = total > 0 && judgedShare >= thresholds.minJudgedShare;

  const hitRate =
    enough && judged.length > 0
      ? (fully + thresholds.partialCredit * partially) / judged.length
      : null;

  return {
    questionsTotal: total,
    questionsJudged: judged.length,
    questionsAnswered: fully,
    questionsPartial: partially,
    questionsUnanswered: none,
    judgedShare,
    hitRate,
    score: hitRate === null ? null : Math.round(100 * hitRate),
    degraded: !enough,
  };
}

/** Questions the site could not answer, worst first — the content-gap input for M13. */
export function unansweredQuestions(
  outcomes: readonly QuestionOutcome[],
  limit: number,
): readonly QuestionOutcome[] {
  const rank: Readonly<Record<Answered, number>> = { no: 0, partially: 1, fully: 2 };
  return outcomes
    .filter((outcome) => outcome.answered === "no" || outcome.answered === "partially")
    .sort((a, b) => {
      const byVerdict = rank[a.answered as Answered] - rank[b.answered as Answered];
      if (byVerdict !== 0) return byVerdict;
      // Within a verdict, the judge's own confidence orders them: a confident "no" is a
      // clearer gap than a hesitant one.
      const byConfidence = (b.confidence ?? 0) - (a.confidence ?? 0);
      return byConfidence === 0 ? a.question.localeCompare(b.question) : byConfidence;
    })
    .slice(0, Math.max(0, limit));
}
