/**
 * Request identity (Engineering-Rules §4): every response carries a `requestId`, every log
 * line in that request's scope carries the same id, and workers later propagate it into
 * job context. One id is what makes a user's "it broke" report traceable end to end.
 */
import { randomFillSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { formatUuidV7 } from "../../domain/shared/uuid.js";

const entropy = new Uint8Array(10);

export function newRequestId(): string {
  randomFillSync(entropy);
  return `req_${formatUuidV7(Date.now(), entropy).replaceAll("-", "")}`;
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    // Trust an inbound id only from our own edge; otherwise a client could forge
    // correlation ids across tenants.
    reply.header("x-request-id", request.id);
  });
}
