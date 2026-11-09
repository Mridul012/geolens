/**
 * Creating a project bundles the tenancy spine in one transaction: the project, its OWN
 * site, and optionally a competitor (docs/API.md §3 — POST /projects).
 */
import type { Project } from "../../contracts/api/projects.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { invalidUrl } from "../../domain/shared/app-error.js";
import { normalizeSiteUrl } from "../../domain/crawl/url.js";
import { limitsFor } from "../../config/plans.js";
import type { ProjectsRepo, NewSite } from "../../infrastructure/db/repositories/projects.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import { competitorLimitError, projectLimitError, urlRejectionToError } from "./errors.js";

export interface CreateProjectDeps {
  readonly projects: ProjectsRepo;
  readonly users: UsersRepo;
}

export interface CreateProjectInput {
  readonly userId: string;
  readonly name: string;
  readonly url: string;
  readonly competitorUrl?: string | undefined;
  readonly timezone: string;
}

export async function createProject(
  deps: CreateProjectDeps,
  input: CreateProjectInput,
): Promise<Result<Project, AppError>> {
  const own = normalizeSiteUrl(input.url);
  if (!own.ok) return err(urlRejectionToError(own.reason, "url"));

  const sites: NewSite[] = [
    { url: own.value.href, domain: own.value.hostname, role: "OWN", name: null },
  ];

  if (input.competitorUrl !== undefined) {
    const competitor = normalizeSiteUrl(input.competitorUrl);
    if (!competitor.ok) return err(urlRejectionToError(competitor.reason, "competitorUrl"));
    if (competitor.value.href === own.value.href) {
      return err(invalidUrl("competitorUrl: a competitor cannot be the same site as your own."));
    }
    sites.push({
      url: competitor.value.href,
      domain: competitor.value.hostname,
      role: "COMPETITOR",
      name: null,
    });
  }

  // Entitlements are resolved server-side at the enforcement point, never from the client
  // (docs/Backend.md §11).
  const plan = await deps.users.findPlan(input.userId);
  const limits = limitsFor(plan);

  const existing = await deps.projects.countOwned(input.userId);
  if (existing >= limits.projects) return err(projectLimitError(plan, limits.projects));
  if (sites.length - 1 > limits.competitorsPerProject) {
    return err(competitorLimitError(plan, limits.competitorsPerProject));
  }

  return ok(
    await deps.projects.create({
      userId: input.userId,
      name: input.name,
      timezone: input.timezone,
      sites,
    }),
  );
}
