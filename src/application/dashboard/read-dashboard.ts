/**
 * Serving the dashboard (docs/API.md §3 — "Redis-cached; never computes").
 *
 * The read path is one cache lookup. A miss rebuilds, because a cold Redis must not turn
 * into an empty dashboard — but a miss is a fallback, not the design: the pipeline writes
 * this payload at the end of every crawl, so in steady state this function does exactly
 * one `GET`.
 *
 * Both the read and the write to Redis are best-effort: docs/Backend.md §16's documented
 * failure mode is "Redis down → web app serves reads (Postgres) fine" — a customer must
 * never see a 500 because the cache, not the data, is unavailable. A failed read is
 * treated exactly like a miss; a failed write after a successful rebuild is swallowed,
 * since the dashboard has already been served correctly and the next reader simply pays
 * the same rebuild cost until Redis returns.
 */
import type { Dashboard } from "../../contracts/api/dashboard.js";
import type { Result } from "../../domain/shared/result.js";
import { ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";
import {
  buildDashboard,
  dashboardKey,
  DASHBOARD_TTL_SECONDS,
  type DashboardDeps,
} from "./build-dashboard.js";

export interface ReadDashboardDeps extends DashboardDeps {
  readonly projects: ProjectsRepo;
}

export async function readDashboard(
  deps: ReadDashboardDeps,
  projectId: string,
  userId: string,
): Promise<Result<Dashboard, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const cached = await readCacheSafely(deps, projectId);
  if (cached !== null) return ok(cached);

  // Cold cache — or Redis itself unreachable: either way, compute from Postgres.
  const dashboard = await buildDashboard(deps, projectId);
  await writeCacheSafely(deps, projectId, dashboard);
  return ok(dashboard);
}

async function readCacheSafely(
  deps: ReadDashboardDeps,
  projectId: string,
): Promise<Dashboard | null> {
  try {
    return await deps.cache.get<Dashboard>(dashboardKey(projectId));
  } catch {
    return null;
  }
}

async function writeCacheSafely(
  deps: ReadDashboardDeps,
  projectId: string,
  dashboard: Dashboard,
): Promise<void> {
  try {
    await deps.cache.set(dashboardKey(projectId), dashboard, DASHBOARD_TTL_SECONDS);
  } catch {
    // Best-effort — the read has already succeeded from Postgres.
  }
}
