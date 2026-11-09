/**
 * The fake payment gateway (mirrors `infrastructure/ai/adapters/fake.adapter.ts` and
 * `infrastructure/email/fake-mailer.ts`): no real Stripe call, no real signature check, so
 * local development, CI, and tests can exercise checkout → webhook → entitlement flip with
 * no Stripe account at all. Refused in production by `config/env.ts`'s coherence check.
 *
 * There is no real Stripe envelope to unwrap here, so the webhook body *is* a
 * `BillingEvent` literal — a test or a local script sends exactly the object it wants
 * `handleBillingWebhook` to see. The one thing this still enforces is that some
 * `stripe-signature` header is present, so a route wired for "signature-verified" behaves
 * the same shape in both modes even though fake mode does not cryptographically check it.
 */
import { randomUUID } from "node:crypto";
import type { SubscriptionStatus } from "../../domain/billing/status.js";
import type {
  BillingEvent,
  CheckoutSessionInput,
  PaymentGateway,
  PortalSessionInput,
} from "../../application/ports/payment-gateway.port.js";
import { InvalidWebhookSignatureError } from "../../application/ports/payment-gateway.port.js";

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
];

function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

export class FakePaymentGateway implements PaymentGateway {
  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ url: string }> {
    return {
      url: `https://fake-checkout.geolens.local/session/${randomUUID()}?userId=${input.userId}`,
    };
  }

  async createPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
    return {
      url: `https://fake-portal.geolens.local/session/${randomUUID()}?customer=${input.stripeCustomerId}`,
    };
  }

  parseWebhookEvent(rawBody: Buffer, signature: string): BillingEvent {
    if (signature.length === 0) throw new InvalidWebhookSignatureError();

    try {
      const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
      return this.#toBillingEvent(parsed);
    } catch {
      throw new InvalidWebhookSignatureError();
    }
  }

  #toBillingEvent(value: unknown): BillingEvent {
    if (typeof value !== "object" || value === null || !("type" in value)) {
      return { type: "unhandled" };
    }
    const record = value as Record<string, unknown>;
    switch (record["type"]) {
      case "checkout.completed":
        if (
          typeof record["userId"] === "string" &&
          typeof record["stripeCustomerId"] === "string" &&
          typeof record["stripeSubscriptionId"] === "string"
        ) {
          return {
            type: "checkout.completed",
            userId: record["userId"],
            stripeCustomerId: record["stripeCustomerId"],
            stripeSubscriptionId: record["stripeSubscriptionId"],
          };
        }
        return { type: "unhandled" };
      case "subscription.updated":
        if (
          typeof record["stripeCustomerId"] === "string" &&
          typeof record["stripeSubscriptionId"] === "string" &&
          isSubscriptionStatus(record["status"])
        ) {
          return {
            type: "subscription.updated",
            stripeCustomerId: record["stripeCustomerId"],
            stripeSubscriptionId: record["stripeSubscriptionId"],
            status: record["status"],
            currentPeriodEnd:
              typeof record["currentPeriodEnd"] === "string"
                ? new Date(record["currentPeriodEnd"])
                : null,
          };
        }
        return { type: "unhandled" };
      case "subscription.deleted":
        if (
          typeof record["stripeCustomerId"] === "string" &&
          typeof record["stripeSubscriptionId"] === "string"
        ) {
          return {
            type: "subscription.deleted",
            stripeCustomerId: record["stripeCustomerId"],
            stripeSubscriptionId: record["stripeSubscriptionId"],
          };
        }
        return { type: "unhandled" };
      default:
        return { type: "unhandled" };
    }
  }
}
