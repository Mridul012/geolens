/**
 * The fake payment gateway (M19) — mirrors the fake AI/email adapters: same interface,
 * no real provider, so the whole billing flow is exercisable with no Stripe account.
 */
import { describe, expect, it } from "vitest";
import { FakePaymentGateway } from "../../../src/infrastructure/payments/fake-gateway.js";
import { InvalidWebhookSignatureError } from "../../../src/application/ports/payment-gateway.port.js";

describe("FakePaymentGateway", () => {
  it("returns a synthetic checkout URL naming the user", async () => {
    const gateway = new FakePaymentGateway();
    const result = await gateway.createCheckoutSession({
      userId: "user-1",
      email: "a@b.test",
      stripeCustomerId: null,
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
    });
    expect(result.url).toContain("user-1");
  });

  it("returns a synthetic portal URL naming the customer", async () => {
    const gateway = new FakePaymentGateway();
    const result = await gateway.createPortalSession({
      stripeCustomerId: "cus_1",
      returnUrl: "https://app.test/billing",
    });
    expect(result.url).toContain("cus_1");
  });

  it("parses a BillingEvent literal directly, with no real signature check", () => {
    const gateway = new FakePaymentGateway();
    const body = Buffer.from(
      JSON.stringify({
        type: "checkout.completed",
        userId: "user-1",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
      }),
    );

    expect(gateway.parseWebhookEvent(body, "any-non-empty-value")).toEqual({
      type: "checkout.completed",
      userId: "user-1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
  });

  it("still requires the signature header to be present", () => {
    const gateway = new FakePaymentGateway();
    const body = Buffer.from(JSON.stringify({ type: "unhandled" }));
    expect(() => gateway.parseWebhookEvent(body, "")).toThrow(InvalidWebhookSignatureError);
  });

  it("rejects a body that is not valid JSON", () => {
    const gateway = new FakePaymentGateway();
    expect(() => gateway.parseWebhookEvent(Buffer.from("not json"), "sig")).toThrow(
      InvalidWebhookSignatureError,
    );
  });

  it("treats a well-formed but incomplete event as unhandled rather than throwing", () => {
    const gateway = new FakePaymentGateway();
    const body = Buffer.from(JSON.stringify({ type: "checkout.completed", userId: "user-1" }));
    expect(gateway.parseWebhookEvent(body, "sig")).toEqual({ type: "unhandled" });
  });

  it("treats an unrecognized type as unhandled", () => {
    const gateway = new FakePaymentGateway();
    const body = Buffer.from(JSON.stringify({ type: "invoice.paid" }));
    expect(gateway.parseWebhookEvent(body, "sig")).toEqual({ type: "unhandled" });
  });
});
