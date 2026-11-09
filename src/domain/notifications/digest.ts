/**
 * The weekly digest's content (docs/Backend.md §13 — "skips if nothing changed, respect
 * the inbox"). Pure: everything here has already been read from the database, and the
 * only decision this file makes is whether there is anything worth a customer's attention.
 */

export interface DigestInputs {
  readonly previousComposite: number | null;
  readonly currentComposite: number | null;
  readonly citationGained: number;
  readonly citationLost: number;
  readonly recommendationsOpened: number;
  readonly recommendationsResolved: number;
}

export interface DigestContent {
  /** Null when there is no prior score to compare against (first week). */
  readonly scoreDelta: number | null;
  readonly currentComposite: number | null;
  readonly citationGained: number;
  readonly citationLost: number;
  readonly recommendationsOpened: number;
  readonly recommendationsResolved: number;
}

/**
 * Composes the digest, or returns `null` when the week produced nothing worth an email.
 *
 * "Nothing changed" means the score held steady and no citation moved and no
 * recommendation opened or closed — the exact set of numbers this file's own type exposes.
 * A project's first-ever published score is treated as news even though there is no prior
 * value to diff against: "you now have a score" is not the same claim as "nothing to
 * report". A quiet week, on the other hand, is not a failure to report; it is only quiet.
 */
export function composeDigest(inputs: DigestInputs): DigestContent | null {
  const scoreDelta =
    inputs.previousComposite === null || inputs.currentComposite === null
      ? null
      : inputs.currentComposite - inputs.previousComposite;

  const scoreIsNews =
    inputs.currentComposite !== null && (inputs.previousComposite === null || scoreDelta !== 0);

  const nothingChanged =
    !scoreIsNews &&
    inputs.citationGained === 0 &&
    inputs.citationLost === 0 &&
    inputs.recommendationsOpened === 0 &&
    inputs.recommendationsResolved === 0;

  if (nothingChanged) return null;

  return {
    scoreDelta,
    currentComposite: inputs.currentComposite,
    citationGained: inputs.citationGained,
    citationLost: inputs.citationLost,
    recommendationsOpened: inputs.recommendationsOpened,
    recommendationsResolved: inputs.recommendationsResolved,
  };
}
