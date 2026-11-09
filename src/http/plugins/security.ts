/**
 * CSRF stance and transport hardening (Engineering-Rules §12).
 *
 * Session cookies are `SameSite=Lax` + httpOnly, so the browser already refuses to attach
 * them to cross-site POSTs. Two belts on top: a strict CORS allowlist (never a wildcard —
 * wildcards and credentials are mutually exclusive for good reason), and an explicit
 * Origin check on every mutating request, which catches the non-browser cases SameSite
 * cannot see.
 */
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { AppError } from "../../domain/shared/app-error.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface SecurityOptions {
  readonly allowedOrigins: readonly string[];
  /** Paths exempt from the Origin check — signature-verified webhooks have no Origin. */
  readonly originCheckExemptPaths?: readonly string[];
}

export async function registerSecurity(
  app: FastifyInstance,
  options: SecurityOptions,
): Promise<void> {
  const allowed = new Set(options.allowedOrigins);
  const exempt = options.originCheckExemptPaths ?? [];

  await app.register(helmet, {
    // The API serves JSON, not documents; CSP belongs to the web app's own responses.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      // Same-origin and non-browser clients send no Origin at all.
      if (origin === undefined || allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "idempotency-key"],
    exposedHeaders: [
      "x-request-id",
      "location",
      "retry-after",
      "ratelimit-limit",
      "ratelimit-remaining",
      "ratelimit-reset",
    ],
    maxAge: 600,
  });

  app.addHook("onRequest", async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (exempt.some((path) => request.url.startsWith(path))) return;

    const origin = request.headers.origin;
    // A browser always sends Origin on a cross-site mutation. Its absence means a
    // same-origin form post or a first-party server call, both of which are fine.
    if (origin !== undefined && !allowed.has(origin)) {
      throw new AppError("VALIDATION_FAILED", {
        detail: "Request origin is not allowed.",
        fields: [{ path: "origin", message: "Disallowed origin" }],
      });
    }
  });
}
