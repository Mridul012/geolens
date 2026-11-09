/**
 * `GET /me` — profile, plan, and usage against the plan's limits.
 *
 * The backend is the source of truth for entitlements (docs/Backend.md §11): the client
 * renders these numbers and never derives them, so the upgrade prompt in the UI and the
 * gate in the API can never disagree.
 */
import type { Me } from "../../contracts/api/auth.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import { limitsFor } from "../../config/plans.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import type { Clock } from "../ports/clock.port.js";

export interface GetCurrentUserDeps {
  readonly users: UsersRepo;
  readonly clock: Clock;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getCurrentUser(
  deps: GetCurrentUserDeps,
  userId: string,
): Promise<Result<Me, AppError>> {
  const profile = await deps.users.findById(userId);
  if (profile === null) {
    // A live session whose user row is gone: treat as unauthenticated-ish rather than 500.
    return err(notFound("User"));
  }

  const plan = await deps.users.findPlan(userId);
  const limits = limitsFor(plan);
  const usage = await deps.users.countUsage(userId, new Date(deps.clock.now().getTime() - WEEK_MS));

  return ok({
    id: profile.id,
    email: profile.email,
    name: profile.name,
    plan,
    usage: {
      projects: { used: usage.projects, limit: limits.projects },
      activePrompts: { used: usage.activePrompts, limit: limits.activePrompts },
      onDemandRunsThisWeek: {
        used: usage.onDemandRunsThisWeek,
        limit: limits.onDemandRunsPerWeek,
      },
    },
  });
}
