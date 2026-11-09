/**
 * The composite score (AI-Pipeline §5) — pure, deterministic, and the number the product
 * is named for.
 *
 * Two properties make this defensible rather than a black box, and both live here:
 *
 * **Renormalization.** A component with no value does not score zero; it leaves the
 * calculation, and the remaining weights are rescaled to sum to one. The distinction
 * between *why* it is absent is carried but never changes the arithmetic: a first crawl
 * has no prompt run, so `citation` is `unavailable_yet` — that is normal, not degraded.
 *
 * **A publication floor.** Below half the total weight there is no score at all. A number
 * computed from a third of the evidence, presented next to one computed from all of it,
 * is a lie of precision — and this product's whole pitch is that its scores are auditable.
 * "Score pending" is the honest output.
 */

export const SCORE_COMPONENTS = [
  "citation",
  "retrievability",
  "contentQuality",
  "topicCoverage",
  "technical",
  "trust",
] as const;

export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

/** Why a component has no value. The UI shows "degraded" only for `failed`. */
export type AbsenceReason = "unavailable_yet" | "failed";

export interface ScoringWeights {
  readonly version: string;
  readonly weights: Readonly<Record<ScoreComponent, number>>;
  /** Below this share of total weight, no score row is written. */
  readonly publicationFloor: number;
}

export interface ComponentInput {
  /** 0–100, or null when the component has no value. */
  readonly value: number | null;
  /** Required when `value` is null; ignored otherwise. */
  readonly reason?: AbsenceReason;
  /** Ids the breakdown drawer links to — chunk ids, snapshot ids, a crawl id. */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export type ComponentInputs = Readonly<Record<ScoreComponent, ComponentInput>>;

/** One row of the breakdown drawer. This payload *is* the drawer (AI-Pipeline §5.2). */
export interface ComponentBreakdown {
  readonly component: ScoreComponent;
  readonly value: number | null;
  /** The component's base weight, before renormalization. */
  readonly weight: number;
  /** Its share of the composite after absent components dropped out; 0 when absent. */
  readonly effectiveWeight: number;
  readonly reason: AbsenceReason | null;
  readonly evidence: Readonly<Record<string, unknown>> | null;
}

export interface CompositeResult {
  /** Null when the publication floor was not met — "score pending", never a number. */
  readonly composite: number | null;
  /** Sum of the base weights of the components that had a value. */
  readonly totalWeight: number;
  readonly published: boolean;
  readonly components: readonly ComponentBreakdown[];
  /** True when at least one component was attempted and failed. */
  readonly degraded: boolean;
  readonly configVersion: string;
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Slack for the publication-floor comparison.
 *
 * The weights are decimal fractions summed in binary: retrievability + contentQuality +
 * technical + trust is exactly the documented 0.50, but IEEE-754 makes it
 * 0.49999999999999994. Without this a site sitting precisely on the boundary would be told
 * its score is pending because of a rounding artefact nobody could see or explain.
 */
const WEIGHT_EPSILON = 1e-9;

/**
 * Computes the composite from its parts.
 *
 * Same inputs, same output, forever: no clock, no randomness, no I/O. That is what makes
 * "unchanged site scores within ±3 points" (§5.3) a property of the system rather than a
 * hope, and it is why re-scoring a crawl is always safe.
 */
export function computeComposite(
  inputs: ComponentInputs,
  config: ScoringWeights,
): CompositeResult {
  const components: ComponentBreakdown[] = [];
  let totalWeight = 0;
  let weightedSum = 0;
  let degraded = false;

  for (const component of SCORE_COMPONENTS) {
    const input = inputs[component];
    const weight = config.weights[component];

    if (input.value === null) {
      const reason = input.reason ?? "unavailable_yet";
      if (reason === "failed") degraded = true;
      components.push({
        component,
        value: null,
        weight,
        effectiveWeight: 0,
        reason,
        evidence: input.evidence ?? null,
      });
      continue;
    }

    const value = clampScore(input.value);
    totalWeight += weight;
    weightedSum += value * weight;
    components.push({
      component,
      value,
      weight,
      // Filled in below, once the surviving total is known.
      effectiveWeight: 0,
      reason: null,
      evidence: input.evidence ?? null,
    });
  }

  const published = totalWeight >= config.publicationFloor - WEIGHT_EPSILON;

  const withEffectiveWeights = components.map((breakdown) =>
    breakdown.value === null || totalWeight === 0
      ? breakdown
      : { ...breakdown, effectiveWeight: breakdown.weight / totalWeight },
  );

  return {
    composite: published ? Math.round(weightedSum / totalWeight) : null,
    totalWeight,
    published,
    components: withEffectiveWeights,
    degraded,
    configVersion: config.version,
  };
}

/** The stored `components` JSONB — the breakdown drawer, verbatim. */
export function toComponentsPayload(result: CompositeResult): Record<string, unknown> {
  return {
    configVersion: result.configVersion,
    totalWeight: result.totalWeight,
    published: result.published,
    degraded: result.degraded,
    components: result.components.map((breakdown) => ({
      component: breakdown.component,
      value: breakdown.value,
      weight: breakdown.weight,
      effectiveWeight: Number(breakdown.effectiveWeight.toFixed(4)),
      reason: breakdown.reason,
      evidence: breakdown.evidence,
    })),
  };
}

/** The per-component columns on the `scores` row. */
export function toComponentColumns(
  result: CompositeResult,
): Readonly<Record<ScoreComponent, number | null>> {
  return Object.fromEntries(
    result.components.map((breakdown) => [breakdown.component, breakdown.value]),
  ) as Readonly<Record<ScoreComponent, number | null>>;
}
