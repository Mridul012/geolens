/**
 * The crawl-complete email (docs/Backend.md §13). Fires once per crawl, from the
 * aggregate fan-in — the same place the score and the dashboard are finalized — so a
 * customer's inbox and their dashboard never disagree about whether a crawl is done.
 */
import { crawlCompleteEmail } from "../../domain/notifications/templates.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { Mailer } from "../ports/mailer.port.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";

export interface NotifyCrawlCompleteDeps {
  readonly projects: ProjectsRepo;
  readonly users: UsersRepo;
  readonly scores: ScoresRepo;
  readonly mailer: Mailer;
  readonly baseUrl: string;
  readonly log: JobLogger;
}

export interface NotifyCrawlCompleteInput {
  readonly projectId: string;
  readonly crawlId: string;
}

export async function notifyCrawlComplete(
  deps: NotifyCrawlCompleteDeps,
  input: NotifyCrawlCompleteInput,
): Promise<Result<void, AppError>> {
  const project = await deps.projects.findAnyById(input.projectId);
  if (project === null) return err(notFound("Project"));

  const user = await deps.users.findById(project.userId);
  if (user === null) return err(notFound("User"));

  const ownSite = project.sites.find((site) => site.role === "OWN");
  const score = await deps.scores.findForCrawl(input.crawlId);

  const email = crawlCompleteEmail({
    projectName: project.name,
    domain: ownSite?.domain ?? "",
    composite: score?.score.composite ?? null,
    dashboardUrl: `${deps.baseUrl}/projects/${project.id}`,
  });

  await deps.mailer.send({ to: user.email, ...email });
  deps.log.info({ projectId: project.id, crawlId: input.crawlId }, "crawl-complete email sent");
  return ok(undefined);
}
