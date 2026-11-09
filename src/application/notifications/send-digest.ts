/**
 * The weekly digest send (docs/Backend.md §13 — "skips if nothing changed"). The tick that
 * enqueues this job already decided the project is due; this file decides whether the week
 * actually produced anything worth a customer's attention, and only then spends an email.
 */
import { composeDigest } from "../../domain/notifications/digest.js";
import { digestEmail } from "../../domain/notifications/templates.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { Clock } from "../ports/clock.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { Mailer } from "../ports/mailer.port.js";
import type { EventsRepo } from "../../infrastructure/db/repositories/events.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { RecommendationsRepo } from "../../infrastructure/db/repositories/recommendations.repo.js";
import type { ScoresRepo } from "../../infrastructure/db/repositories/scores.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";

export interface SendDigestDeps {
  readonly projects: ProjectsRepo;
  readonly users: UsersRepo;
  readonly scores: ScoresRepo;
  readonly events: EventsRepo;
  readonly recommendations: RecommendationsRepo;
  readonly mailer: Mailer;
  readonly clock: Clock;
  readonly baseUrl: string;
  readonly log: JobLogger;
}

export interface SendDigestInput {
  readonly projectId: string;
}

export interface SendDigestResult {
  readonly sent: boolean;
}

/** How far back the digest looks for citation and recommendation movement. */
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The two most recent scores give "current" and "a week ago" without a date query. */
const TREND_POINTS = 2;

export async function sendDigest(
  deps: SendDigestDeps,
  input: SendDigestInput,
): Promise<Result<SendDigestResult, AppError>> {
  const project = await deps.projects.findAnyById(input.projectId);
  if (project === null) return err(notFound("Project"));

  const user = await deps.users.findById(project.userId);
  if (user === null) return err(notFound("User"));

  const since = new Date(deps.clock.now().getTime() - DIGEST_WINDOW_MS);
  const trend = await deps.scores.recentTrend(input.projectId, TREND_POINTS);
  const previousComposite = trend.length === TREND_POINTS ? (trend[0]?.composite ?? null) : null;
  const currentComposite = trend.at(-1)?.composite ?? null;

  const [citationGained, citationLost, churn] = await Promise.all([
    deps.events.countSince(input.projectId, "citation_gained", since),
    deps.events.countSince(input.projectId, "citation_lost", since),
    deps.recommendations.churnSince(input.projectId, since),
  ]);

  const content = composeDigest({
    previousComposite,
    currentComposite,
    citationGained,
    citationLost,
    recommendationsOpened: churn.opened,
    recommendationsResolved: churn.resolved,
  });

  if (content === null) {
    deps.log.info({ projectId: project.id }, "digest skipped — nothing changed this week");
    return ok({ sent: false });
  }

  const ownSite = project.sites.find((site) => site.role === "OWN");
  const email = digestEmail({
    projectName: project.name,
    domain: ownSite?.domain ?? "",
    content,
    dashboardUrl: `${deps.baseUrl}/projects/${project.id}`,
  });

  await deps.mailer.send({ to: user.email, ...email });
  deps.log.info({ projectId: project.id }, "digest sent");
  return ok({ sent: true });
}
