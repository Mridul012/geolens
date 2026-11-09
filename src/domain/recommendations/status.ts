/**
 * Recommendation status transitions (docs/API.md §3) — pure.
 *
 * Five states, but only three of them belong to the user. `VALIDATED` and `REGRESSED` are
 * set by the pipeline when a later crawl proves an issue fixed or found it again, and a
 * client that could set them itself would be able to mark its own homework — the whole
 * value of "we checked, and it is actually fixed" is that we checked.
 */
export type RecStatus = "OPEN" | "DONE" | "DISMISSED" | "VALIDATED" | "REGRESSED";

/** The only statuses `PATCH` accepts. Anything else is a 400, not a silent no-op. */
export const CLIENT_SETTABLE: readonly RecStatus[] = ["OPEN", "DONE", "DISMISSED"];

/** What the pipeline may set, and from where. */
export const PIPELINE_SETTABLE: readonly RecStatus[] = ["VALIDATED", "REGRESSED"];

const CLIENT_TRANSITIONS: Readonly<Record<RecStatus, readonly RecStatus[]>> = Object.freeze({
  OPEN: ["DONE", "DISMISSED"],
  DONE: ["OPEN"],
  DISMISSED: ["OPEN"],
  // A finding the pipeline confirmed fixed can be reopened by hand — the user may
  // disagree, or may have reverted the change — but it cannot be marked DONE again.
  VALIDATED: ["OPEN"],
  // A regression is an open issue with history; the user works it like any other.
  REGRESSED: ["DONE", "DISMISSED"],
});

export interface TransitionError {
  readonly reason: "not_client_settable" | "illegal_transition";
  readonly detail: string;
}

/** Whether a client may move a recommendation from `from` to `to`. */
export function canClientTransition(from: RecStatus, to: RecStatus): TransitionError | null {
  if (!CLIENT_SETTABLE.includes(to)) {
    return {
      reason: "not_client_settable",
      detail: `${to} is set by the pipeline when a later crawl checks the issue, not by a client.`,
    };
  }
  if (from === to) return null;
  if (!(CLIENT_TRANSITIONS[from] ?? []).includes(to)) {
    return {
      reason: "illegal_transition",
      detail: `A recommendation cannot move from ${from} to ${to}.`,
    };
  }
  return null;
}

/**
 * What a later crawl does to a recommendation it did or did not see again.
 *
 * Returns null when nothing changes, so a re-crawl only writes where something actually
 * moved — a `updated_at` that ticks every week on an untouched card is noise in the feed.
 */
export function statusAfterRecrawl(
  current: RecStatus,
  stillPresent: boolean,
): RecStatus | null {
  if (stillPresent) {
    // The user said they fixed it and it is still here. That is worth saying out loud.
    return current === "DONE" || current === "VALIDATED" ? "REGRESSED" : null;
  }
  // Gone. Only a claim of "done" earns confirmation; a dismissed issue stays dismissed,
  // because the user's decision to ignore it is not ours to overturn.
  return current === "DONE" ? "VALIDATED" : null;
}
