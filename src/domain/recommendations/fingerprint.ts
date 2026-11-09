/**
 * Recommendation identity and ranking (M13) — pure.
 *
 * The fingerprint is what makes the to-do list a list rather than a log. A site with a
 * blocked GPTBot has *one* problem, not one per weekly crawl, so the same issue seen again
 * updates a row instead of adding one. Get this wrong in either direction and the feature
 * fails: too loose and two different problems merge into one card; too tight and the user
 * watches the same card reappear every Monday with a new id, and stops trusting the list.
 *
 * So the fingerprint is deliberately coarse — the *kind* of problem, not its current
 * extent. "Three thin pages" and "seven thin pages" are the same finding with a different
 * count, and the count belongs in the evidence, which is free to change.
 */

/** Non-word runs collapse to a single dash, so a title change cannot fork a card. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface FingerprintInput {
  readonly source: "RULE" | "AI";
  /** Set for rule findings; null for a model's suggestion. */
  readonly ruleKey: string | null;
  /** The model's own hint at what kind of issue this is, when it gave one. */
  readonly ruleHint?: string | null;
  readonly title: string;
}

/**
 * A stable identity for one recommendation.
 *
 * Rule findings key on `ruleKey` alone: the rule *is* the issue, and its wording can be
 * improved without orphaning every card in every account. Model suggestions have no such
 * anchor, so they fall back to a slug of the title — accepting that a substantially
 * reworded suggestion will read as a new card, which is the honest outcome, because a
 * reworded suggestion usually *is* a different suggestion.
 */
export function fingerprintOf(input: FingerprintInput): string {
  if (input.ruleKey !== null && input.ruleKey.length > 0) {
    return `rule:${input.ruleKey}`;
  }
  const hint = input.ruleHint ?? null;
  if (hint !== null && hint.length > 0) return `ai:${slug(hint)}`;
  return `ai:${slug(input.title)}`;
}

export interface Rankable {
  readonly impact: number;
  readonly difficulty: number;
  readonly priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  readonly source: "RULE" | "AI";
  readonly title: string;
}

const PRIORITY_ORDER: Readonly<Record<Rankable["priority"], number>> = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
});

/** Impact divided by difficulty: the cheapest big win first (PRD FR-9.3). */
export function leverageOf(item: Pick<Rankable, "impact" | "difficulty">): number {
  return item.impact / Math.max(1, item.difficulty);
}

/**
 * Orders the list the way a person should work through it.
 *
 * Priority leads, because a CRITICAL finding is not merely a high-leverage one — a blocked
 * crawler makes every other item on the list moot. Within a priority, leverage decides.
 * Rules break ties over model output, since a rule is a fact and a suggestion is not.
 */
export function rankRecommendations<T extends Rankable>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => {
    const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (byPriority !== 0) return byPriority;

    const byLeverage = leverageOf(b) - leverageOf(a);
    if (Math.abs(byLeverage) > 1e-9) return byLeverage;

    if (a.source !== b.source) return a.source === "RULE" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
