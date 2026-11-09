/**
 * Identity and entitlement reads.
 *
 * Repositories accept and return domain/contract shapes — Prisma types never cross out of
 * this folder (golden rule #3), which is why every method below maps explicitly instead of
 * handing back a model.
 */
import type { Database } from "../prisma.js";
import type { PlanTier } from "../../../config/plans.js";

export interface UserProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly emailVerified: boolean;
}

export interface UsageCounts {
  readonly projects: number;
  readonly activePrompts: number;
  readonly onDemandRunsThisWeek: number;
}

export class UsersRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async findById(userId: string): Promise<UserProfile | null> {
    const user = await this.#db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerified: true },
    });
    return user === null
      ? null
      : {
          id: user.id,
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
        };
  }

  /**
   * Resolves the account's plan. An account with no subscription row is FREE — absence is
   * a state, not an error (docs/Database.md §2.3).
   *
   * Index: `subscriptions.user_id` is unique.
   */
  async findPlan(userId: string): Promise<PlanTier> {
    const subscription = await this.#db.subscription.findUnique({
      where: { userId },
      select: { plan: true, status: true },
    });
    if (subscription === null) return "FREE";
    // A cancelled or past-due subscription loses its entitlements immediately; billing
    // decides when to flip the row, not the read path.
    return subscription.status === "ACTIVE" || subscription.status === "TRIALING"
      ? subscription.plan
      : "FREE";
  }

  /**
   * Usage the `/me` block reports and the gates enforce.
   *
   * Indexes: `projects(user_id)`, `prompt_templates(project_id, status)`,
   * `prompt_runs(project_id, created_at DESC)` — all scoped through the user's projects.
   */
  async countUsage(userId: string, weekStart: Date): Promise<UsageCounts> {
    const [projects, activePrompts, onDemandRunsThisWeek] = await Promise.all([
      this.#db.project.count({ where: { userId, deletedAt: null } }),
      this.#db.promptTemplate.count({
        where: { status: "ACTIVE", project: { userId, deletedAt: null } },
      }),
      this.#db.promptRun.count({
        where: {
          trigger: "MANUAL",
          createdAt: { gte: weekStart },
          project: { userId, deletedAt: null },
        },
      }),
    ]);
    return { projects, activePrompts, onDemandRunsThisWeek };
  }
}
