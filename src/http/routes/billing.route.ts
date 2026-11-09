/** Billing routes (docs/API.md §3 — Billing). */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { checkoutUrlSchema } from "../../contracts/api/billing.js";
import { problemSchema } from "../../contracts/api/errors.js";
import { startCheckout, type StartCheckoutDeps } from "../../application/billing/start-checkout.js";
import { startPortal, type StartPortalDeps } from "../../application/billing/start-portal.js";

export interface BillingRouteDeps {
  readonly checkout: StartCheckoutDeps;
  readonly portal: StartPortalDeps;
}

export function registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/v1/billing/checkout",
    {
      schema: {
        tags: ["Billing"],
        summary: "Create a Stripe Checkout session for the PRO plan",
        response: { 200: checkoutUrlSchema, 401: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await startCheckout(deps.checkout, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.post(
    "/v1/billing/portal",
    {
      schema: {
        tags: ["Billing"],
        summary: "Create a Stripe customer-portal session (manage/cancel)",
        response: { 200: checkoutUrlSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await startPortal(deps.portal, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );
}
