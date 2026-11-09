/**
 * The prompt-simulation processor — a controller (Engineering-Rules §2.2).
 *
 * Beyond running the simulation it does one thing the crawl pipeline does not: on
 * completion it triggers a *new score row* with `prompt_run_id` set. That is the moment
 * the citation component goes live — the largest single weight in the composite, and the
 * difference between an estimated visibility score and a measured one.
 */
import type { PromptSimJob } from "../../contracts/jobs/index.js";
import type { JobContext } from "../../application/ports/job-context.port.js";
import {
  runPromptSimulation,
  type RunPromptSimulationDeps,
} from "../../application/prompt-sim/run-prompt-simulation.js";
import {
  scorePromptRun,
  type ScorePromptRunDeps,
} from "../../application/scoring/score-prompt-run.js";
import { rebuildDashboard, type DashboardDeps } from "../../application/dashboard/build-dashboard.js";

export interface PromptSimProcessorDeps {
  readonly simulation: Omit<RunPromptSimulationDeps, "log" | "shouldStop">;
  readonly scoring: Omit<ScorePromptRunDeps, "log">;
  readonly dashboard?: DashboardDeps | undefined;
}

export function createPromptSimProcessor(deps: PromptSimProcessorDeps) {
  return async (job: PromptSimJob, context: JobContext): Promise<void> => {
    const result = await runPromptSimulation(
      { ...deps.simulation, log: context.log, shouldStop: context.shouldStop },
      {
        projectId: job.projectId,
        runId: job.runId,
        engines: job.engines,
        ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
      },
    );

    if (!result.ok) {
      // A project deleted mid-flight, or no tracked prompts left. Nothing to retry.
      context.log.warn(
        { runId: job.runId, code: result.error.code },
        "prompt run resolved to nothing",
      );
      return;
    }

    await context.reportProgress({
      cells: result.value.cells,
      evaluableCells: result.value.evaluableCells,
      citationScore: result.value.citationScore,
    });

    const scored = await scorePromptRun(
      { ...deps.scoring, log: context.log },
      { projectId: job.projectId, runId: job.runId },
    );
    if (!scored.ok) {
      context.log.warn(
        { runId: job.runId, code: scored.error.code },
        "prompt run produced no score row",
      );
    }

    if (deps.dashboard !== undefined) {
      try {
        await rebuildDashboard(deps.dashboard, job.projectId);
      } catch (error) {
        context.log.error({ runId: job.runId, err: error }, "dashboard rebuild failed");
      }
    }
  };
}
