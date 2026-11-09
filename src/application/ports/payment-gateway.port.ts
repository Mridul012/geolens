/**
 * Payments behind a port (Engineering-Rules §2.2). Use cases speak in checkout/portal
 * sessions and a small `BillingEvent` union; they never import the Stripe SDK or learn
 * Stripe's own event/object shapes — that translation is the adapter's entire job.
 */
import type { SubscriptionStatus } from "../../domain/billing/status.js";

export interface CheckoutSessionInput {
  readonly userId: string;
  readonly email: string;
  /** Present when the user already has a Stripe customer from a prior subscription. */
  readonly stripeCustomerId: string | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface PortalSessionInput {
  readonly stripeCustomerId: string;
  readonly returnUrl: string;
}

/**
 * A checkout session's completion carries our own `userId` (set as Checkout's
 * `client_reference_id` at creation) — the one point where a Stripe customer is first
 * linked to an account. Every later lifecycle event only ever carries Stripe's own ids, so
 * the application layer resolves those against a `subscriptions` row created here.
 */
export type BillingEvent =
  | {
      readonly type: "checkout.completed";
      readonly userId: string;
      readonly stripeCustomerId: string;
      readonly stripeSubscriptionId: string;
    }
  | {
      readonly type: "subscription.updated";
      readonly stripeCustomerId: string;
      readonly stripeSubscriptionId: string;
      readonly status: SubscriptionStatus;
      readonly currentPeriodEnd: Date | null;
    }
  | {
      readonly type: "subscription.deleted";
      readonly stripeCustomerId: string;
      readonly stripeSubscriptionId: string;
    }
  /** An event type this product does not act on — acknowledged, never a failure. */
  | { readonly type: "unhandled" };

export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super("Webhook signature verification failed");
    this.name = "InvalidWebhookSignatureError";
  }
}

export interface PaymentGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ readonly url: string }>;
  createPortalSession(input: PortalSessionInput): Promise<{ readonly url: string }>;
  /** @throws {InvalidWebhookSignatureError} when `signature` does not verify. */
  parseWebhookEvent(rawBody: Buffer, signature: string): BillingEvent;
}
