/**
 * Scoring a completed prompt run (M15) — the second writer inside `application/scoring/`,
 * and still the only folder that writes a `scores` row (golden rule #2).
 *
 * This is where the citation component goes live. Until a run exists, `citation` is absent
 * with reason `unavailable_yet` and the composite is renormalized over the other five —
 * ordinary, not degraded. Afterwards the largest single weight in the score is a
 * measurement of what engines actually said, which is the entire claim the product makes.
 *
 * The crawl components come from the project's most recent crawl rather than being
 * recomputed: they have not changed since it finished, and re-deriving them here would let
 * a prompt run silently restate a crawl's findings from stale inputs.
 */
import { ACTIVE_SCORING_CONFIG } from "../../config/scoring/v1.js";
import {
  computeComposite,
  toComponentColumns,
  toComponentsPayload,
  type ComponentInput,
  type ComponentInputs,
  type ScoreComponent,
} from "../../domain/scoring/composite.js";
import type { Score } from "../../contracts/api/scores.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { degraded, notFound } from "../../domain/shared/app-error.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { EventsRepo } from "../../infrastructure/db/repositories/events.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";

export interface ScorePromptRunDeps {
  readonly runs: PromptRunsRepo;
  readonly scores: ScoresRepo;
  readonly events: EventsRepo;
  readonly log: JobLogger;
}

export interface ScorePromptRunInput {
  readonly projectId: string;
  readonly runId: string;
}

export interface ScorePromptRunResult {
  readonly score: Score | null;
  readonly published: boolean;
}

/** Crawl-derived components, carried forward from the latest score row. */
const CARRIED: readonly ScoreComponent[] = [
  "retrievability",
  "contentQuality",
  "topicCoverage",
  "technical",
  "trust",
];

export async function scorePromptRun(
  deps: ScorePromptRunDeps,
  input: ScorePromptRunInput,
): Promise<Result<ScorePromptRunResult, AppError>> {
  const run = await deps.runs.findInProject(input.projectId, input.runId);
  if (run === null) return err(notFound("Prompt run"));

  const metrics = (run.metrics ?? {}) as { citationScore?: unknown };
  const citationValue = typeof metrics.citationScore === "number" ? metrics.citationScore : null;

  if (citationValue === null) {
    // A run that measured nothing must not overwrite a good score with a worse one built
    // from an outage.
    deps.log.warn({ runId: input.runId }, "prompt run produced no citation score");
    return err(degraded("This run measured no evaluable cells."));
  }

  const previous = await deps.scores.findLatest(input.projectId);
  const previousRows = Array.isArray(
    (previous?.components as { components?: unknown } | undefined)?.components,
  )
    ? ((previous?.components as { components: Array<Record<string, unknown>> }).components)
    : [];
  const byComponent = new Map(previousRows.map((row) => [String(row["component"]), row]));

  const carried = Object.fromEntries(
    CARRIED.map((component) => {
      const row = byComponent.get(component);
      const value = typeof row?.["value"] === "number" ? (row["value"] as number) : null;
      const input_: ComponentInput =
        value === null
          ? { value: null, reason: "unavailable_yet" }
          : {
              value,
              evidence: (row?.["evidence"] as Record<string, unknown> | null) ?? {
                carriedFrom: previous?.score.id ?? null,
              },
            };
      return [component, input_];
    }),
  ) as Omit<ComponentInputs, "citation">;

  const inputs: ComponentInputs = {
    ...carried,
    citation: {
      value: citationValue,
      evidence: {
        promptRunId: input.runId,
        mentionRate: run.mentionRate,
        citationShare: run.citationShare,
        engines: run.engines,
      },
    },
  };

  const result = computeComposite(inputs, ACTIVE_SCORING_CONFIG);
  const components = toComponentsPayload(result);

  if (!result.published || result.composite === null) {
    deps.log.warn(
      { runId: input.runId, totalWeight: result.totalWeight },
      "publication floor not met after the run; no score written",
    );
    return ok({ score: null, published: false });
  }

  const columns = toComponentColumns(result);
  const score = await deps.scores.insert({
    projectId: input.projectId,
    crawlId: null,
    promptRunId: input.runId,
    composite: result.composite,
    citation: columns.citation,
    retrievability: columns.retrievability,
    contentQuality: columns.contentQuality,
    topicCoverage: columns.topicCoverage,
    technical: columns.technical,
    trust: columns.trust,
    components,
    scoringConfigVersion: result.configVersion,
  });

  // The "what changed" feed reads these; a citation that appeared or disappeared is the
  // single most interesting thing that can happen to this product's users.
  //
  // A first measurement is a gain, not a loss — there was nothing to lose. And a first
  // measurement of zero is neither: the customer has not lost visibility, we have only
  // just started looking.
  const before = previous?.score.scoreCitation ?? null;
  const movement =
    before === null
      ? citationValue > 0
        ? "citation_gained"
        : null
      : citationValue > before
        ? "citation_gained"
        : citationValue < before
          ? "citation_lost"
          : null;

  if (movement !== null) {
    await deps.events.record({
      projectId: input.projectId,
      kind: movement,
      payload: { runId: input.runId, from: before, to: citationValue },
    });
  }

  await deps.events.record({
    projectId: input.projectId,
    kind: "score_changed",
    payload: { composite: result.composite, promptRunId: input.runId },
  });

  deps.log.info(
    { runId: input.runId, composite: result.composite, citation: citationValue },
    "prompt run scored",
  );

  return ok({ score, published: true });
}
