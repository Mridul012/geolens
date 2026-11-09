/**
 * Starting a Stripe Checkout session (docs/API.md §3 — `POST /billing/checkout`).
 *
 * Reuses an existing Stripe customer when the account has one — a churned-and-returning
 * customer gets their history back in the Stripe dashboard rather than a duplicate.
 */
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { PaymentGateway } from "../ports/payment-gateway.port.js";
import type { SubscriptionsRepo } from "../../infrastructure/db/repositories/subscriptions.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";

export interface StartCheckoutDeps {
  readonly users: UsersRepo;
  readonly subscriptions: SubscriptionsRepo;
  readonly gateway: PaymentGateway;
  readonly baseUrl: string;
}

export async function startCheckout(
  deps: StartCheckoutDeps,
  userId: string,
): Promise<Result<{ url: string }, AppError>> {
  const user = await deps.users.findById(userId);
  if (user === null) return err(notFound("User"));

  const existing = await deps.subscriptions.findByUserId(userId);

  const session = await deps.gateway.createCheckoutSession({
    userId,
    email: user.email,
    stripeCustomerId: existing?.stripeCustomerId ?? null,
    successUrl: `${deps.baseUrl}/billing/success`,
    cancelUrl: `${deps.baseUrl}/billing/canceled`,
  });

  return ok(session);
}
