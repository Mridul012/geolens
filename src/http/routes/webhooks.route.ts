/**
 * `POST /v1/webhooks/stripe` (docs/API.md §3 — System group).
 *
 * Signature verification needs the exact bytes Stripe signed, not a re-serialized JSON
 * object — so this route's content-type parser is scoped to a private child instance via
 * `app.register`, leaving every other route's normal JSON body parsing untouched.
 */
import type { FastifyInstance } from "fastify";
import { validationFailed } from "../../domain/shared/app-error.js";
import { InvalidWebhookSignatureError } from "../../application/ports/payment-gateway.port.js";
import type { PaymentGateway } from "../../application/ports/payment-gateway.port.js";
import {
  handleBillingWebhook,
  type HandleBillingWebhookDeps,
} from "../../application/billing/handle-webhook.js";

export interface WebhookRouteDeps extends HandleBillingWebhookDeps {
  readonly gateway: PaymentGateway;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  void app.register(async (instance) => {
    instance.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );

    instance.post(
      "/v1/webhooks/stripe",
      { schema: { tags: ["Billing"], summary: "Stripe webhook (signature-verified)", hide: true } },
      async (request, reply) => {
        const signature = request.headers["stripe-signature"];
        if (typeof signature !== "string" || signature.length === 0) {
          throw validationFailed([
            { path: "stripe-signature", message: "This header is required." },
          ]);
        }

        let event;
        try {
          event = deps.gateway.parseWebhookEvent(request.body as Buffer, signature);
        } catch (error) {
          if (error instanceof InvalidWebhookSignatureError) {
            throw validationFailed([{ path: "stripe-signature", message: error.message }]);
          }
          throw error;
        }

        const result = await handleBillingWebhook(deps, event);
        if (!result.recognized) {
          request.log.warn({ eventType: event.type }, "webhook event not applied");
        }

        return reply.code(200).send({ received: true });
      },
    );
  });
}
