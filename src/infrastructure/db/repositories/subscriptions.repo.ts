/**
 * The `subscriptions` table (docs/Database.md §2.3) — billing's own writes.
 *
 * `UsersRepo.findPlan` reads this table everywhere entitlements are checked; this repo is
 * the only place that writes it, so "who can change a customer's plan" has one answer,
 * mirroring the golden-rule pattern already used for `scores`.
 */
import type { Database } from "../prisma.js";
import type { PlanTier } from "../../../config/plans.js";
import type { SubscriptionStatus } from "../../../domain/billing/status.js";
import { newUuidV7 } from "../uuid.js";

export interface SubscriptionState {
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string | null;
  readonly plan: PlanTier;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
}

export class SubscriptionsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async findByUserId(userId: string): Promise<{ readonly stripeCustomerId: string } | null> {
    const row = await this.#db.subscription.findUnique({
      where: { userId },
      select: { stripeCustomerId: true },
    });
    return row === null ? null : { stripeCustomerId: row.stripeCustomerId };
  }

  /**
   * The one point a Stripe customer is first linked to an account (docs/Backend.md §14) —
   * called only from a `checkout.session.completed` event. Upsert, not insert: a customer
   * who churned and re-subscribes reuses their existing row rather than colliding on the
   * unique `user_id`.
   */
  async upsertForUser(userId: string, state: SubscriptionState): Promise<void> {
    await this.#db.subscription.upsert({
      where: { userId },
      create: { id: newUuidV7(), userId, ...state },
      update: { ...state },
    });
  }

  /**
   * Every subsequent lifecycle event (`customer.subscription.*`) carries only Stripe's own
   * ids, so it updates by `stripeCustomerId` — the row `upsertForUser` already created.
   * Returns whether a row was found, so the caller can tell a genuinely unknown customer
   * apart from routine processing.
   */
  async updateByStripeCustomerId(
    stripeCustomerId: string,
    patch: Partial<Omit<SubscriptionState, "stripeCustomerId">>,
  ): Promise<boolean> {
    const result = await this.#db.subscription.updateMany({
      where: { stripeCustomerId },
      data: { ...patch },
    });
    return result.count > 0;
  }
}
