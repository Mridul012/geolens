/**
 * Payments over the Stripe SDK (docs/Backend.md §14 — signature-verified webhooks,
 * entitlements resolved server-side). Legal home for the Stripe SDK: infra implements the
 * port, nothing else touches Stripe.
 */
import Stripe from "stripe";
import { mapStripeSubscriptionStatus } from "../../domain/billing/status.js";
import type {
  BillingEvent,
  CheckoutSessionInput,
  PaymentGateway,
  PortalSessionInput,
} from "../../application/ports/payment-gateway.port.js";
import { InvalidWebhookSignatureError } from "../../application/ports/payment-gateway.port.js";

export class StripePaymentGateway implements PaymentGateway {
  readonly #client: Stripe;
  readonly #priceId: string;
  readonly #webhookSecret: string;

  constructor(secretKey: string, priceId: string, webhookSecret: string) {
    this.#client = new Stripe(secretKey);
    this.#priceId = priceId;
    this.#webhookSecret = webhookSecret;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ url: string }> {
    const session = await this.#client.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: this.#priceId, quantity: 1 }],
      // The one point a Stripe customer is linked back to our own account id.
      client_reference_id: input.userId,
      ...(input.stripeCustomerId === null
        ? { customer_email: input.email }
        : { customer: input.stripeCustomerId }),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (session.url === null) {
      throw new Error("Stripe did not return a checkout URL");
    }
    return { url: session.url };
  }

  async createPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
    const session = await this.#client.billingPortal.sessions.create({
      customer: input.stripeCustomerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  parseWebhookEvent(rawBody: Buffer, signature: string): BillingEvent {
    let event: Stripe.Event;
    try {
      event = this.#client.webhooks.constructEvent(rawBody, signature, this.#webhookSecret);
    } catch {
      throw new InvalidWebhookSignatureError();
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        if (
          userId === null ||
          typeof customerId !== "string" ||
          typeof subscriptionId !== "string"
        ) {
          return { type: "unhandled" };
        }
        return {
          type: "checkout.completed",
          userId,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
        };
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = event.data.object as Stripe.Subscription;
        if (typeof subscription.customer !== "string") return { type: "unhandled" };
        return {
          type: "subscription.updated",
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          status: mapStripeSubscriptionStatus(subscription.status),
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        };
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        if (typeof subscription.customer !== "string") return { type: "unhandled" };
        return {
          type: "subscription.deleted",
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
        };
      }
      default:
        return { type: "unhandled" };
    }
  }
}
