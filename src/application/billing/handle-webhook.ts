/**
 * Applying a billing event (docs/API.md §3 — `POST /webhooks/stripe`).
 *
 * Every branch upserts by a Stripe id, never by inserting blindly — a replayed event lands
 * on the same row and produces the same final state, which is the whole of "idempotency by
 * Stripe IDs" (M19 acceptance). There is deliberately no separate processed-event ledger:
 * the subscription row itself is the idempotency key.
 */
import type { BillingEvent } from "../ports/payment-gateway.port.js";
import type { SubscriptionsRepo } from "../../infrastructure/db/repositories/subscriptions.repo.js";

export interface HandleBillingWebhookDeps {
  readonly subscriptions: SubscriptionsRepo;
}

export interface HandleBillingWebhookResult {
  /** False only for a lifecycle event about a customer this account never linked. */
  readonly recognized: boolean;
}

export async function handleBillingWebhook(
  deps: HandleBillingWebhookDeps,
  event: BillingEvent,
): Promise<HandleBillingWebhookResult> {
  switch (event.type) {
    case "checkout.completed": {
      await deps.subscriptions.upsertForUser(event.userId, {
        stripeCustomerId: event.stripeCustomerId,
        stripeSubscriptionId: event.stripeSubscriptionId,
        plan: "PRO",
        // The subscription's authoritative status follows in a `customer.subscription.*`
        // event; ACTIVE here reflects the checkout Stripe just confirmed as completed.
        status: "ACTIVE",
        currentPeriodEnd: null,
      });
      return { recognized: true };
    }
    case "subscription.updated": {
      const recognized = await deps.subscriptions.updateByStripeCustomerId(
        event.stripeCustomerId,
        {
          stripeSubscriptionId: event.stripeSubscriptionId,
          plan: "PRO",
          status: event.status,
          currentPeriodEnd: event.currentPeriodEnd,
        },
      );
      return { recognized };
    }
    case "subscription.deleted": {
      // `UsersRepo.findPlan` already treats any non-ACTIVE/TRIALING status as FREE, so
      // flipping the status is the entire downgrade — no separate "revert to FREE" write.
      const recognized = await deps.subscriptions.updateByStripeCustomerId(
        event.stripeCustomerId,
        { status: "CANCELED" },
      );
      return { recognized };
    }
    case "unhandled":
      return { recognized: false };
  }
}
