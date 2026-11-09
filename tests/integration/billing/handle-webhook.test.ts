/**
 * Applying billing events (M19 acceptance): a checkout flips the plan to PRO immediately,
 * a cancellation drops it back to FREE, and replaying any event is a no-op rather than a
 * duplicate — "idempotency by Stripe IDs" means the subscription row itself is the key,
 * not a separate processed-event ledger.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { handleBillingWebhook } from "../../../src/application/billing/handle-webhook.js";
import { SubscriptionsRepo } from "../../../src/infrastructure/db/repositories/subscriptions.repo.js";
import { UsersRepo } from "../../../src/infrastructure/db/repositories/users.repo.js";
import { createTestPrisma, truncateAll } from "../../helpers/db.js";

let prisma: PrismaClient;
let subscriptions: SubscriptionsRepo;
let users: UsersRepo;

beforeAll(() => {
  prisma = createTestPrisma();
  subscriptions = new SubscriptionsRepo(prisma);
  users = new UsersRepo(prisma);
});

beforeEach(async () => {
  await truncateAll(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `webhook-${Date.now()}-${Math.random()}@example.test` },
  });
  return user.id;
}

describe("checkout.completed", () => {
  it("creates a subscription row and flips the plan to PRO immediately", async () => {
    const userId = await seedUser();

    const result = await handleBillingWebhook(
      { subscriptions },
      {
        type: "checkout.completed",
        userId,
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
      },
    );

    expect(result.recognized).toBe(true);
    expect(await users.findPlan(userId)).toBe("PRO");
    expect(await subscriptions.findByUserId(userId)).toEqual({ stripeCustomerId: "cus_123" });
  });

  it("replaying the same event is a no-op, not a duplicate", async () => {
    const userId = await seedUser();
    const event = {
      type: "checkout.completed" as const,
      userId,
      stripeCustomerId: "cus_456",
      stripeSubscriptionId: "sub_456",
    };

    await handleBillingWebhook({ subscriptions }, event);
    await handleBillingWebhook({ subscriptions }, event);
    await handleBillingWebhook({ subscriptions }, event);

    const rows = await prisma.subscription.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stripeCustomerId).toBe("cus_456");
  });
});

describe("subscription.updated", () => {
  it("syncs status and period end for a known customer", async () => {
    const userId = await seedUser();
    await handleBillingWebhook(
      { subscriptions },
      {
        type: "checkout.completed",
        userId,
        stripeCustomerId: "cus_789",
        stripeSubscriptionId: "sub_789",
      },
    );

    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const result = await handleBillingWebhook(
      { subscriptions },
      {
        type: "subscription.updated",
        stripeCustomerId: "cus_789",
        stripeSubscriptionId: "sub_789",
        status: "ACTIVE",
        currentPeriodEnd: periodEnd,
      },
    );

    expect(result.recognized).toBe(true);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    expect(row.currentPeriodEnd).toEqual(periodEnd);
  });

  it("a PAST_DUE status loses entitlements immediately", async () => {
    const userId = await seedUser();
    await handleBillingWebhook(
      { subscriptions },
      {
        type: "checkout.completed",
        userId,
        stripeCustomerId: "cus_pd",
        stripeSubscriptionId: "sub_pd",
      },
    );
    expect(await users.findPlan(userId)).toBe("PRO");

    await handleBillingWebhook(
      { subscriptions },
      {
        type: "subscription.updated",
        stripeCustomerId: "cus_pd",
        stripeSubscriptionId: "sub_pd",
        status: "PAST_DUE",
        currentPeriodEnd: null,
      },
    );

    expect(await users.findPlan(userId)).toBe("FREE");
  });

  it("is not recognized for a customer this account never linked", async () => {
    const result = await handleBillingWebhook(
      { subscriptions },
      {
        type: "subscription.updated",
        stripeCustomerId: "cus_unknown",
        stripeSubscriptionId: "sub_unknown",
        status: "ACTIVE",
        currentPeriodEnd: null,
      },
    );

    expect(result.recognized).toBe(false);
  });
});

describe("subscription.deleted", () => {
  it("cancels the subscription — findPlan reverts to FREE with no separate downgrade write", async () => {
    const userId = await seedUser();
    await handleBillingWebhook(
      { subscriptions },
      {
        type: "checkout.completed",
        userId,
        stripeCustomerId: "cus_cancel",
        stripeSubscriptionId: "sub_cancel",
      },
    );
    expect(await users.findPlan(userId)).toBe("PRO");

    const result = await handleBillingWebhook(
      { subscriptions },
      { type: "subscription.deleted", stripeCustomerId: "cus_cancel", stripeSubscriptionId: "sub_cancel" },
    );

    expect(result.recognized).toBe(true);
    expect(await users.findPlan(userId)).toBe("FREE");
    // The row itself still exists (customer history), only its status changed.
    const row = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
    expect(row.status).toBe("CANCELED");
    expect(row.plan).toBe("PRO");
  });

  it("replaying the deletion is a no-op", async () => {
    const userId = await seedUser();
    await handleBillingWebhook(
      { subscriptions },
      { type: "checkout.completed", userId, stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" },
    );
    const event = {
      type: "subscription.deleted" as const,
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_x",
    };

    await handleBillingWebhook({ subscriptions }, event);
    await handleBillingWebhook({ subscriptions }, event);

    expect(await users.findPlan(userId)).toBe("FREE");
    expect(await prisma.subscription.count({ where: { userId } })).toBe(1);
  });
});

describe("unhandled", () => {
  it("is a pure no-op", async () => {
    const result = await handleBillingWebhook({ subscriptions }, { type: "unhandled" });
    expect(result.recognized).toBe(false);
  });
});
