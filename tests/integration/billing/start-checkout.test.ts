/**
 * Starting checkout (M19): a returning customer's existing Stripe customer id is reused
 * rather than creating a duplicate customer in Stripe.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { startCheckout } from "../../../src/application/billing/start-checkout.js";
import { FakePaymentGateway } from "../../../src/infrastructure/payments/fake-gateway.js";
import { SubscriptionsRepo } from "../../../src/infrastructure/db/repositories/subscriptions.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createTestPrisma();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("startCheckout", () => {
  it("reuses an existing Stripe customer for a returning subscriber", async () => {
    const user = await prisma.user.create({ data: { email: "returning@acme.test" } });
    await prisma.subscription.create({
      data: { userId: user.id, stripeCustomerId: "cus_returning", plan: "PRO", status: "CANCELED" },
    });

    let capturedCustomerId: string | null | undefined;
    const gateway = new FakePaymentGateway();
    const originalCreate = gateway.createCheckoutSession.bind(gateway);
    gateway.createCheckoutSession = async (input) => {
      capturedCustomerId = input.stripeCustomerId;
      return originalCreate(input);
    };

    const result = await startCheckout(
      {
        users: new UsersRepo(prisma),
        subscriptions: new SubscriptionsRepo(prisma),
        gateway,
        baseUrl: "https://app.geolens.example",
      },
      user.id,
    );

    if (!result.ok) throw result.error;
    expect(capturedCustomerId).toBe("cus_returning");
  });

  it("passes no customer id for a brand-new subscriber", async () => {
    const user = await prisma.user.create({ data: { email: "brand-new@acme.test" } });

    let capturedCustomerId: string | null | undefined;
    const gateway = new FakePaymentGateway();
    const originalCreate = gateway.createCheckoutSession.bind(gateway);
    gateway.createCheckoutSession = async (input) => {
      capturedCustomerId = input.stripeCustomerId;
      return originalCreate(input);
    };

    const result = await startCheckout(
      {
        users: new UsersRepo(prisma),
        subscriptions: new SubscriptionsRepo(prisma),
        gateway,
        baseUrl: "https://app.geolens.example",
      },
      user.id,
    );

    if (!result.ok) throw result.error;
    expect(capturedCustomerId).toBeNull();
  });

  it("resolves to nothing for a user that does not exist", async () => {
    const result = await startCheckout(
      {
        users: new UsersRepo(prisma),
        subscriptions: new SubscriptionsRepo(prisma),
        gateway: new FakePaymentGateway(),
        baseUrl: "https://app.geolens.example",
      },
      "00000000-0000-0000-0000-000000000000",
    );

    expect(result.ok).toBe(false);
  });
});
