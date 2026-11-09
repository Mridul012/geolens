/**
 * Topic-coverage thresholds, v1 (AI-Pipeline §3.4).
 *
 * These numbers decide what "covered" means, so they live in `config/scoring/` and nowhere
 * else (Engineering-Rules §15.6). Changing any of them changes every score in the product:
 * add a `coverage.v2.ts` beside this file and version the callers rather than editing the
 * constants in place, so historical coverage stays interpretable.
 */
import type { CoverageThresholds } from "../../domain/topics/coverage.js";

export const COVERAGE_V1: CoverageThresholds = Object.freeze({
  version: "coverage.v1",
  matchThreshold: 0.62,
  simFloor: 0.55,
  simRange: 0.3,
  depthSaturation: 5,
  qualityWeight: 0.6,
  depthWeight: 0.4,
  competitorStrongAtLeast: 60,
  ownAbsentAtMost: 25,
  evidenceChunks: 5,
});

/** The version in force. Callers take this, never a literal. */
export const ACTIVE_COVERAGE_THRESHOLDS = COVERAGE_V1;
