/**
 * Competitor sites (docs/API.md §3 — Competitors group).
 *
 * A competitor is a `sites` row crawled by the identical pipeline, so adding one is a
 * tenancy operation, not a separate feature (docs/Database.md §2.5).
 */
import type { Site } from "../../contracts/api/projects.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { invalidUrl, notFound, validationFailed } from "../../domain/shared/app-error.js";
import { normalizeSiteUrl } from "../../domain/crawl/url.js";
import { limitsFor } from "../../config/plans.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { SitesRepo } from "../../infrastructure/db/repositories/sites.repo.js";
import { isUniqueViolation } from "../../infrastructure/db/repositories/sites.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import { assertProjectAccess } from "./assert-project-access.js";
import { competitorLimitError, urlRejectionToError } from "./errors.js";

export interface CompetitorDeps {
  readonly projects: ProjectsRepo;
  readonly sites: SitesRepo;
  readonly users: UsersRepo;
}

export async function listCompetitors(
  deps: CompetitorDeps,
  projectId: string,
  userId: string,
): Promise<Result<readonly Site[], AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;
  return ok(await deps.sites.listForProject(projectId, "COMPETITOR"));
}

export async function addCompetitor(
  deps: CompetitorDeps,
  projectId: string,
  userId: string,
  input: { readonly url: string; readonly name?: string | undefined },
): Promise<Result<Site, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const normalized = normalizeSiteUrl(input.url);
  if (!normalized.ok) return err(urlRejectionToError(normalized.reason, "url"));

  const ownSite = await deps.sites.findOwnSite(projectId);
  if (ownSite !== null && ownSite.url === normalized.value.href) {
    return err(invalidUrl("url: a competitor cannot be the same site as your own."));
  }

  const plan = await deps.users.findPlan(userId);
  const limit = limitsFor(plan).competitorsPerProject;
  if ((await deps.sites.countCompetitors(projectId)) >= limit) {
    return err(competitorLimitError(plan, limit));
  }

  try {
    return ok(
      await deps.sites.addCompetitor({
        projectId,
        url: normalized.value.href,
        domain: normalized.value.hostname,
        name: input.name ?? null,
      }),
    );
  } catch (error) {
    // `UNIQUE (project_id, url)` is the backstop; racing requests land here, not in a 500.
    if (isUniqueViolation(error)) {
      return err(
        validationFailed([{ path: "url", message: "That site is already tracked in this project." }]),
      );
    }
    throw error;
  }
}

export async function removeCompetitor(
  deps: CompetitorDeps,
  projectId: string,
  userId: string,
  siteId: string,
): Promise<Result<null, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const site = await deps.sites.findInProject(projectId, siteId);
  if (site === null) return err(notFound("Site"));
  if (site.role === "OWN") {
    return err(
      validationFailed(
        [{ path: "siteId", message: "The project's own site cannot be removed." }],
        "Delete the project instead.",
      ),
    );
  }

  await deps.sites.removeCompetitor(projectId, siteId);
  return ok(null);
}
