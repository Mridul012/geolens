/**
 * The Stripe adapter's webhook parsing (M19) — real signature verification and real event
 * shapes, with no network call and no Stripe account: `Stripe.webhooks.generateTestHeaderString`
 * signs a payload locally against a secret we make up ourselves, which is exactly what
 * `constructEvent` verifies against on the other side. This is the one piece of the
 * Stripe integration `STRIPE_MODE=fake` cannot exercise, so it gets its own real test.
 */
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripePaymentGateway } from "../../../src/infrastructure/payments/stripe-gateway.js";
import { InvalidWebhookSignatureError } from "../../../src/application/ports/payment-gateway.port.js";

const WEBHOOK_SECRET = "whsec_test_secret";

function sign(payload: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
}

function gateway(): StripePaymentGateway {
  return new StripePaymentGateway("sk_test_unused", "price_test_unused", WEBHOOK_SECRET);
}

function stripeEvent(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({
    id: "evt_test",
    object: "event",
    type,
    data: { object },
  });
}

describe("StripePaymentGateway.parseWebhookEvent", () => {
  it("throws on a signature that does not verify", () => {
    const payload = stripeEvent("checkout.session.completed", {});
    expect(() =>
      gateway().parseWebhookEvent(Buffer.from(payload), "t=1,v1=not-a-real-signature"),
    ).toThrow(InvalidWebhookSignatureError);
  });

  it("maps checkout.session.completed into a checkout.completed event", () => {
    const payload = stripeEvent("checkout.session.completed", {
      id: "cs_test",
      client_reference_id: "user-123",
      customer: "cus_abc",
      subscription: "sub_abc",
    });

    const event = gateway().parseWebhookEvent(Buffer.from(payload), sign(payload));

    expect(event).toEqual({
      type: "checkout.completed",
      userId: "user-123",
      stripeCustomerId: "cus_abc",
      stripeSubscriptionId: "sub_abc",
    });
  });

  it("treats a checkout session with no client_reference_id as unhandled", () => {
    const payload = stripeEvent("checkout.session.completed", {
      id: "cs_test",
      client_reference_id: null,
      customer: "cus_abc",
      subscription: "sub_abc",
    });

    expect(gateway().parseWebhookEvent(Buffer.from(payload), sign(payload))).toEqual({
      type: "unhandled",
    });
  });

  it("maps customer.subscription.updated into a subscription.updated event", () => {
    const payload = stripeEvent("customer.subscription.updated", {
      id: "sub_abc",
      customer: "cus_abc",
      status: "past_due",
      current_period_end: 1_800_000_000,
    });

    const event = gateway().parseWebhookEvent(Buffer.from(payload), sign(payload));

    expect(event).toEqual({
      type: "subscription.updated",
      stripeCustomerId: "cus_abc",
      stripeSubscriptionId: "sub_abc",
      status: "PAST_DUE",
      currentPeriodEnd: new Date(1_800_000_000 * 1000),
    });
  });

  it("maps customer.subscription.deleted into a subscription.deleted event", () => {
    const payload = stripeEvent("customer.subscription.deleted", {
      id: "sub_abc",
      customer: "cus_abc",
      status: "canceled",
    });

    const event = gateway().parseWebhookEvent(Buffer.from(payload), sign(payload));

    expect(event).toEqual({
      type: "subscription.deleted",
      stripeCustomerId: "cus_abc",
      stripeSubscriptionId: "sub_abc",
    });
  });

  it("treats an event type this product does not act on as unhandled", () => {
    const payload = stripeEvent("invoice.paid", { id: "in_test" });

    expect(gateway().parseWebhookEvent(Buffer.from(payload), sign(payload))).toEqual({
      type: "unhandled",
    });
  });
});
