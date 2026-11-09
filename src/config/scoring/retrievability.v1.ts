/**
 * Retrievability simulation parameters, v1 (AI-Pipeline §3.3).
 *
 * The retrieval constants live here with the scoring weights because they *are* scoring
 * inputs: change `rrfK` or `contextChunks` and every retrievability score in the product
 * moves. The pipeline doc fixes `k = 60`, twenty per arm and five fused — those are not
 * tuning knobs, they are part of what the score means. A change gets a `v2` file and a new
 * version string, so a number stored months ago stays interpretable.
 */
import type { RetrievabilityThresholds } from "../../domain/retrieval/metrics.js";

export const RETRIEVABILITY_V1: RetrievabilityThresholds = Object.freeze({
  version: "retrievability.v1",
  vectorTopK: 20,
  lexicalTopK: 20,
  contextChunks: 5,
  rrfK: 60,
  partialCredit: 0.5,
  minJudgedShare: 0.7,
  minQuestions: 30,
  maxQuestions: 50,
});

/** The version in force. Callers take this, never a literal. */
export const ACTIVE_RETRIEVABILITY_THRESHOLDS = RETRIEVABILITY_V1;

/** Unanswered questions carried into the analysis artifact as content-gap evidence. */
export const UNANSWERED_EVIDENCE_LIMIT = 10;
