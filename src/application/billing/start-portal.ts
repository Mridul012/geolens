/**
 * Starting a Stripe customer-portal session (docs/API.md §3 — `POST /billing/portal`) —
 * manage or cancel an existing subscription. There is nothing to manage without one.
 */
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { PaymentGateway } from "../ports/payment-gateway.port.js";
import type { SubscriptionsRepo } from "../../infrastructure/db/repositories/subscriptions.repo.js";

export interface StartPortalDeps {
  readonly subscriptions: SubscriptionsRepo;
  readonly gateway: PaymentGateway;
  readonly baseUrl: string;
}

export async function startPortal(
  deps: StartPortalDeps,
  userId: string,
): Promise<Result<{ url: string }, AppError>> {
  const subscription = await deps.subscriptions.findByUserId(userId);
  if (subscription === null) return err(notFound("Subscription"));

  const session = await deps.gateway.createPortalSession({
    stripeCustomerId: subscription.stripeCustomerId,
    returnUrl: `${deps.baseUrl}/billing`,
  });

  return ok(session);
}
