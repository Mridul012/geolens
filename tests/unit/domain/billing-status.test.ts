import { describe, expect, it } from "vitest";
import { mapStripeSubscriptionStatus } from "../../../src/domain/billing/status.js";

describe("mapStripeSubscriptionStatus", () => {
  it("maps the statuses that grant entitlements", () => {
    expect(mapStripeSubscriptionStatus("trialing")).toBe("TRIALING");
    expect(mapStripeSubscriptionStatus("active")).toBe("ACTIVE");
  });

  it("maps grace-period statuses to PAST_DUE", () => {
    expect(mapStripeSubscriptionStatus("past_due")).toBe("PAST_DUE");
    expect(mapStripeSubscriptionStatus("unpaid")).toBe("PAST_DUE");
  });

  it("maps every non-entitled status to CANCELED", () => {
    expect(mapStripeSubscriptionStatus("canceled")).toBe("CANCELED");
    expect(mapStripeSubscriptionStatus("incomplete")).toBe("CANCELED");
    expect(mapStripeSubscriptionStatus("incomplete_expired")).toBe("CANCELED");
    expect(mapStripeSubscriptionStatus("paused")).toBe("CANCELED");
  });

  it("fails safe — an unrecognized status loses entitlements rather than keeping them", () => {
    expect(mapStripeSubscriptionStatus("some_future_stripe_status")).toBe("CANCELED");
  });
});
