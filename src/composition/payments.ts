/**
 * The only place a payment gateway is constructed (mirrors `composition/email.ts` and
 * `composition/ai.ts`). `STRIPE_MODE=fake` wires the in-memory adapter so checkout,
 * portal, and webhook handling are all exercisable locally and in CI with no Stripe
 * account.
 */
import type { PaymentGateway } from "../application/ports/payment-gateway.port.js";
import { FakePaymentGateway } from "../infrastructure/payments/fake-gateway.js";
import { StripePaymentGateway } from "../infrastructure/payments/stripe-gateway.js";
import { env } from "../config/env.js";

export function createPaymentGateway(): PaymentGateway {
  if (env.STRIPE_MODE === "fake") return new FakePaymentGateway();

  if (
    env.STRIPE_SECRET_KEY === undefined ||
    env.STRIPE_WEBHOOK_SECRET === undefined ||
    env.STRIPE_PRO_PRICE_ID === undefined
  ) {
    // `config/env.ts`'s coherence check already refuses this combination at boot; this is
    // the type-level guard for the branch that check exists to prevent.
    throw new Error('STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRO_PRICE_ID are required when STRIPE_MODE is "live"');
  }
  return new StripePaymentGateway(
    env.STRIPE_SECRET_KEY,
    env.STRIPE_PRO_PRICE_ID,
    env.STRIPE_WEBHOOK_SECRET,
  );
}
