/**
 * Billing endpoints over HTTP (M19 acceptance, docs/API.md §3 — Billing).
 *
 * `STRIPE_MODE=fake` (the test harness's default) means the webhook body *is* a
 * `BillingEvent` literal rather than a signed Stripe envelope — see
 * `infrastructure/payments/fake-gateway.ts`. That is deliberate: this file proves the wire
 * contract end to end (checkout → webhook → `/me` reflects PRO immediately; cancel →
 * downgrade; a replayed webhook causes no duplicate state) without a Stripe account, and
 * `tests/integration/billing/handle-webhook.test.ts` covers the event-application logic on
 * its own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, cookieHeaderFrom, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";

let harness: TestApp;

async function signUp(email = "priya@acme.test"): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Priya" },
  });
  expect(response.statusCode).toBe(200);
  return cookieHeaderFrom(response);
}

async function me(cookie: string) {
  return harness.app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
}

async function sendWebhook(body: Record<string, unknown>, signature = "fake-signature") {
  return harness.app.inject({
    method: "POST",
    url: "/v1/webhooks/stripe",
    headers: { "content-type": "application/json", ...(signature === "" ? {} : { "stripe-signature": signature }) },
    payload: body,
  });
}

beforeAll(async () => {
  harness = await buildTestApp();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await truncateAll(harness.prisma);
});

describe("POST /billing/checkout", () => {
  it("returns a checkout URL for a signed-in user", async () => {
    const cookie = await signUp();

    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/billing/checkout",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toMatch(/^https:\/\//);
  });

  it("requires a session", async () => {
    const response = await harness.app.inject({ method: "POST", url: "/v1/billing/checkout" });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /billing/portal", () => {
  it("404s a user with no subscription yet", async () => {
    const cookie = await signUp();

    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/billing/portal",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns a portal URL once a subscription exists", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email: "priya@acme.test" } });
    await harness.prisma.subscription.create({
      data: { userId: user.id, stripeCustomerId: "cus_portal", plan: "PRO", status: "ACTIVE" },
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/billing/portal",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().url).toMatch(/^https:\/\//);
  });
});

describe("POST /webhooks/stripe", () => {
  it("flips the plan to PRO immediately once checkout completes", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email: "priya@acme.test" } });
    expect((await me(cookie)).json().plan).toBe("FREE");

    const response = await sendWebhook({
      type: "checkout.completed",
      userId: user.id,
      stripeCustomerId: "cus_e2e_1",
      stripeSubscriptionId: "sub_e2e_1",
    });

    expect(response.statusCode).toBe(200);
    expect((await me(cookie)).json().plan).toBe("PRO");
  });

  it("expands limits immediately — a FREE-gated read succeeds right after the webhook", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email: "priya@acme.test" } });
    const project = (
      await harness.app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { cookie },
        payload: { name: "Acme", url: "https://acme.com" },
      })
    ).json();

    const beforeUpgrade = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/comparison`,
      headers: { cookie },
    });
    expect(beforeUpgrade.statusCode).toBe(403);

    await sendWebhook({
      type: "checkout.completed",
      userId: user.id,
      stripeCustomerId: "cus_e2e_gate",
      stripeSubscriptionId: "sub_e2e_gate",
    });

    const afterUpgrade = await harness.app.inject({
      method: "GET",
      url: `/v1/projects/${project.id}/comparison`,
      headers: { cookie },
    });
    expect(afterUpgrade.statusCode).toBe(200);
  });

  it("causes no duplicate state when Stripe replays the same event", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email: "priya@acme.test" } });
    const event = {
      type: "checkout.completed",
      userId: user.id,
      stripeCustomerId: "cus_e2e_replay",
      stripeSubscriptionId: "sub_e2e_replay",
    };

    await sendWebhook(event);
    await sendWebhook(event);
    await sendWebhook(event);

    expect((await me(cookie)).json().plan).toBe("PRO");
    expect(await harness.prisma.subscription.count({ where: { userId: user.id } })).toBe(1);
  });

  it("cancellation downgrades the account back to FREE", async () => {
    const cookie = await signUp();
    const user = await harness.prisma.user.findFirstOrThrow({ where: { email: "priya@acme.test" } });
    await sendWebhook({
      type: "checkout.completed",
      userId: user.id,
      stripeCustomerId: "cus_e2e_cancel",
      stripeSubscriptionId: "sub_e2e_cancel",
    });
    expect((await me(cookie)).json().plan).toBe("PRO");

    const response = await sendWebhook({
      type: "subscription.deleted",
      stripeCustomerId: "cus_e2e_cancel",
      stripeSubscriptionId: "sub_e2e_cancel",
    });

    expect(response.statusCode).toBe(200);
    expect((await me(cookie)).json().plan).toBe("FREE");
  });

  it("400s a request with no signature header", async () => {
    const response = await sendWebhook({ type: "unhandled" }, "");
    expect(response.statusCode).toBe(400);
  });

  it("200s (not applied) for an event type this product does not recognize, rather than erroring", async () => {
    const response = await sendWebhook({ type: "some.other.stripe.event" });
    expect(response.statusCode).toBe(200);
  });
});
