/**
 * Triggering a prompt run (docs/API.md §3 — `POST /prompt-runs`).
 *
 * A run costs real money at real providers, so the guards matter more here than anywhere
 * else in the API: an on-demand quota, one active run per project, and an idempotency key
 * so a double-clicked button does not buy the same measurement twice.
 *
 * The quota resolves PRD Open Question #3 as decided: FREE curates prompts but gets no
 * on-demand runs; PRO gets one a week. A FREE account can still see results from scheduled
 * runs — what it cannot do is spend on demand.
 */
import { PLAN_LIMITS } from "../../config/plans.js";
import type { Engine } from "../../config/model-tiers.js";
import { ENGINES } from "../../config/model-tiers.js";
import type { PromptRun } from "../../contracts/api/prompt-runs.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound, planLimitExceeded, promptRunAlreadyActive } from "../../domain/shared/app-error.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobQueue } from "../ports/job-queue.port.js";
import type { ProgressStore } from "../ports/progress-store.port.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { PromptRunsRepo } from "../../infrastructure/db/repositories/prompt-runs.repo.js";
import type { PromptTemplatesRepo } from "../../infrastructure/db/repositories/prompt-templates.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import { JOB_PRIORITY } from "../../config/queues.js";
import { jobId } from "../../contracts/jobs/index.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface StartPromptRunDeps {
  readonly projects: ProjectsRepo;
  readonly users: UsersRepo;
  readonly runs: PromptRunsRepo;
  readonly prompts: PromptTemplatesRepo;
  readonly queue: JobQueue;
  readonly progress: ProgressStore;
  readonly clock: Clock;
}

export interface StartPromptRunInput {
  readonly projectId: string;
  readonly userId: string;
  readonly trigger?: "MANUAL" | "SCHEDULED" | undefined;
  readonly requestId?: string | undefined;
}

const UNIQUE_VIOLATION = "P2002";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function startPromptRun(
  deps: StartPromptRunDeps,
  input: StartPromptRunInput,
): Promise<Result<PromptRun, AppError>> {
  const access = await assertProjectAccess(deps.projects, input.projectId, input.userId);
  if (!access.ok) return access;

  const templates = await deps.prompts.listForProject(input.projectId, "ACTIVE");
  if (templates.length === 0) {
    // Nothing to ask. A run with no prompts would burn a quota slot on an empty result.
    return err(notFound("Tracked prompts"));
  }

  // Checked before the insert so the common case gets a clear 409 rather than a database
  // error; the partial unique index is the race-proof backstop below.
  if ((await deps.runs.findActiveForProject(input.projectId)) !== null) {
    return err(promptRunAlreadyActive());
  }

  const trigger = input.trigger ?? "MANUAL";
  const plan = await deps.users.findPlan(input.userId);
  const quota = PLAN_LIMITS[plan].onDemandRunsPerWeek;

  if (trigger === "MANUAL") {
    if (quota === 0) {
      return err(
        planLimitExceeded(
          `On-demand prompt runs are not available on the ${plan} plan. Your tracked prompts still run on the scheduled cadence.`,
        ),
      );
    }
    const since = new Date(deps.clock.now().getTime() - WEEK_MS);
    const recent = (await deps.runs.listForProject(input.projectId, quota + 1, undefined)).filter(
      (run) => run.trigger === "MANUAL" && new Date(run.createdAt) >= since,
    );
    if (recent.length >= quota) {
      return err(
        planLimitExceeded(
          `The ${plan} plan allows ${quota} on-demand run${quota === 1 ? "" : "s"} per week.`,
        ),
      );
    }
  }

  const engines: readonly Engine[] = ENGINES;

  let run: PromptRun;
  try {
    run = await deps.runs.create({ projectId: input.projectId, trigger, engines });
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      // Two requests raced; the database decided, and the loser gets the documented 409.
      return err(promptRunAlreadyActive());
    }
    throw error;
  }

  await deps.progress.setPromptRunProgress(run.id, {
    cellsDone: 0,
    cellsTotal: templates.length * engines.length,
    status: null,
  });

  await deps.queue.enqueue(
    "prompt-sim",
    {
      runId: run.id,
      projectId: input.projectId,
      engines: [...engines],
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
    {
      jobId: jobId.promptSim(run.id),
      priority: trigger === "MANUAL" ? JOB_PRIORITY.userTriggered : JOB_PRIORITY.scheduled,
    },
  );

  return ok(run);
}
