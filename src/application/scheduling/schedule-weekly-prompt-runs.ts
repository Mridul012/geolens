/**
 * The weekly prompt-run tick (docs/Backend.md §13), offset a few hours after the
 * project's crawl slot so the crawl has time to finish and hand the run fresh taxonomy and
 * tracked prompts to work from.
 */
import { PROMPT_SIM_OFFSET_HOURS } from "../../config/schedule.js";
import { isDueThisHour } from "../../domain/scheduling/stagger.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";
import { startPromptRun, type StartPromptRunDeps } from "../prompt-sim/start-prompt-run.js";

export interface ScheduleWeeklyPromptRunsDeps extends StartPromptRunDeps {
  readonly projects: ProjectsRepo;
  readonly runs: PromptRunsRepo;
  readonly log: JobLogger;
}

export interface ScheduleWeeklyPromptRunsResult {
  readonly scheduled: number;
  readonly skipped: number;
}

const DEDUPE_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

export async function scheduleWeeklyPromptRuns(
  deps: ScheduleWeeklyPromptRunsDeps,
): Promise<ScheduleWeeklyPromptRunsResult> {
  const now = deps.clock.now();
  const since = new Date(now.getTime() - DEDUPE_WINDOW_MS);
  const eligible = await deps.projects.listScheduledEligible();

  let scheduled = 0;
  let skipped = 0;

  for (const project of eligible) {
    if (!isDueThisHour(project.projectId, project.timezone, now, PROMPT_SIM_OFFSET_HOURS)) {
      continue;
    }

    if (await deps.runs.hasScheduledSince(project.projectId, since)) {
      skipped += 1;
      continue;
    }

    const result = await startPromptRun(deps, {
      projectId: project.projectId,
      userId: project.userId,
      trigger: "SCHEDULED",
    });

    if (!result.ok) {
      // Most commonly no tracked prompts yet, or a run already active.
      deps.log.info(
        { projectId: project.projectId, code: result.error.code },
        "scheduled prompt run skipped",
      );
      skipped += 1;
      continue;
    }

    scheduled += 1;
  }

  return { scheduled, skipped };
}
