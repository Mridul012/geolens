/**
 * The weekly digest (M18 acceptance): correct deltas when something changed, and a clean
 * skip — "respect the inbox" — when nothing did.
 */
import { describe, expect, it } from "vitest";
import { composeDigest, type DigestInputs } from "../../../src/domain/notifications/digest.js";

const QUIET: DigestInputs = {
  previousComposite: 70,
  currentComposite: 70,
  citationGained: 0,
  citationLost: 0,
  recommendationsOpened: 0,
  recommendationsResolved: 0,
};

describe("composeDigest", () => {
  it("skips a week where nothing changed at all", () => {
    expect(composeDigest(QUIET)).toBeNull();
  });

  it("skips a week with no prior score and no other movement", () => {
    expect(composeDigest({ ...QUIET, previousComposite: null, currentComposite: null })).toBeNull();
  });

  it("reports a positive score delta", () => {
    const result = composeDigest({ ...QUIET, previousComposite: 60, currentComposite: 72 });
    expect(result?.scoreDelta).toBe(12);
    expect(result?.currentComposite).toBe(72);
  });

  it("reports a negative score delta", () => {
    const result = composeDigest({ ...QUIET, previousComposite: 72, currentComposite: 60 });
    expect(result?.scoreDelta).toBe(-12);
  });

  it("is not skipped by a citation win alone, even with an unchanged score", () => {
    const result = composeDigest({ ...QUIET, citationGained: 2 });
    expect(result).not.toBeNull();
    expect(result?.citationGained).toBe(2);
    expect(result?.scoreDelta).toBe(0);
  });

  it("is not skipped by a citation loss alone", () => {
    const result = composeDigest({ ...QUIET, citationLost: 1 });
    expect(result?.citationLost).toBe(1);
  });

  it("is not skipped by recommendation churn alone", () => {
    expect(composeDigest({ ...QUIET, recommendationsOpened: 1 })).not.toBeNull();
    expect(composeDigest({ ...QUIET, recommendationsResolved: 1 })).not.toBeNull();
  });

  it("treats a first-ever published score as news, not a null delta that hides it", () => {
    const result = composeDigest({ ...QUIET, previousComposite: null, currentComposite: 55 });
    expect(result).not.toBeNull();
    expect(result?.scoreDelta).toBeNull();
    expect(result?.currentComposite).toBe(55);
  });
});
