// Fastify decorations used across plugins and routes. Declaration merging keeps
// `request.session` and friends typed without casts at every call site.
import type { AuthSession } from "../application/ports/auth.port.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved once per request by the auth plugin; null when unauthenticated. */
    session: AuthSession | null;
  }
  interface FastifyInstance {
    /** Throws AUTH_REQUIRED unless the request carries a valid session. */
    requireSession: (request: FastifyRequest) => AuthSession;
  }
}

export {};
