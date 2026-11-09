/**
 * The budget monitor (docs/Backend.md §13): "projects trending over cost budget → flag
 * before it becomes a margin problem." An ops concern, not a customer-facing one — the
 * warning goes to the ops alert address, never into a project's own "what changed" feed.
 */
import { BUDGET_MONITOR_WINDOW_DAYS, BUDGET_WARNING_RATIO } from "../../config/schedule.js";
import { budgetWarningEmail } from "../../domain/notifications/templates.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { Mailer } from "../ports/mailer.port.js";
import type { AiUsageRepo } from "../../infrastructure/db/repositories/ai-usage.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";

export interface BudgetMonitorDeps {
  readonly projects: ProjectsRepo;
  readonly aiUsage: AiUsageRepo;
  readonly mailer: Mailer;
  readonly clock: Clock;
  /** Per-project trailing-month ceiling in micro-USD (env.AI_BUDGET_PER_PROJECT_MONTHLY_MICROS). */
  readonly budgetMicros: number;
  readonly opsAlertEmail: string | null;
  readonly log: JobLogger;
}

export async function monitorBudgets(
  deps: BudgetMonitorDeps,
): Promise<{ readonly flagged: number }> {
  const since = new Date(
    deps.clock.now().getTime() - BUDGET_MONITOR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const threshold = deps.budgetMicros * BUDGET_WARNING_RATIO;
  const projects = await deps.projects.listActive();

  let flagged = 0;
  for (const project of projects) {
    const spent = await deps.aiUsage.totalForProjectSince(project.id, since);
    if (Number(spent) < threshold) continue;

    flagged += 1;
    deps.log.warn(
      { projectId: project.id, spentMicros: spent.toString(), budgetMicros: deps.budgetMicros },
      "project trending over its AI spend budget",
    );
    if (deps.opsAlertEmail !== null) {
      const email = budgetWarningEmail({
        projectName: project.name,
        spentMicros: spent,
        budgetMicros: deps.budgetMicros,
        windowDays: BUDGET_MONITOR_WINDOW_DAYS,
      });
      await deps.mailer.send({ to: deps.opsAlertEmail, ...email });
    }
  }

  deps.log.info({ flagged }, "budget monitor complete");
  return { flagged };
}
