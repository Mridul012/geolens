/**
 * Auth routes (docs/API.md §3 — Auth group).
 *
 * Thin by construction: validate → call the gateway → map the result. The library's own
 * routes (OAuth callbacks, token exchange) are proxied through a wildcard so we never
 * reimplement a protocol, but the three endpoints the frontend depends on return the
 * documented `SessionInfo` shape rather than whatever the library happens to emit.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuthGateway, IssuedSession } from "../../application/ports/auth.port.js";
import {
  sessionInfoSchema,
  signInBodySchema,
  signUpBodySchema,
  socialSignInBodySchema,
  type SessionInfo,
} from "../../contracts/api/auth.js";
import { problemSchema } from "../../contracts/api/errors.js";
import { authRequired } from "../../domain/shared/app-error.js";
import { toHeaders } from "../plugins/auth.js";

export interface AuthRouteDeps {
  readonly auth: AuthGateway;
}

function toSessionInfo(session: IssuedSession | { user: SessionInfo["user"]; expiresAt: Date }): SessionInfo {
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
    session: { expiresAt: session.expiresAt.toISOString() },
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/v1/auth/sign-up/email",
    {
      config: { rateLimitBucket: "auth" },
      schema: {
        tags: ["Auth"],
        summary: "Create an account with email + password",
        security: [],
        body: signUpBodySchema,
        response: {
          200: sessionInfoSchema,
          400: problemSchema,
          409: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await deps.auth.signUpWithEmail({
        ...request.body,
        ip: request.ip,
        ...(request.headers["user-agent"] === undefined
          ? {}
          : { userAgent: request.headers["user-agent"] }),
      });
      if (!result.ok) throw result.error;

      for (const cookie of result.value.setCookies) reply.header("set-cookie", cookie);
      return reply.code(200).send(toSessionInfo(result.value));
    },
  );

  routes.post(
    "/v1/auth/sign-in/email",
    {
      config: { rateLimitBucket: "auth" },
      schema: {
        tags: ["Auth"],
        summary: "Sign in with email + password",
        security: [],
        body: signInBodySchema,
        response: { 200: sessionInfoSchema, 401: problemSchema, 429: problemSchema },
      },
    },
    async (request, reply) => {
      const result = await deps.auth.signInWithEmail({
        ...request.body,
        ip: request.ip,
        ...(request.headers["user-agent"] === undefined
          ? {}
          : { userAgent: request.headers["user-agent"] }),
      });
      if (!result.ok) throw result.error;

      for (const cookie of result.value.setCookies) reply.header("set-cookie", cookie);
      return reply.code(200).send(toSessionInfo(result.value));
    },
  );

  routes.post(
    "/v1/auth/sign-in/social",
    {
      config: { rateLimitBucket: "auth" },
      schema: {
        tags: ["Auth"],
        summary: "Start Google OAuth (returns the redirect URL)",
        security: [],
        body: socialSignInBodySchema,
        response: { 200: z.object({ url: z.string().url() }), 400: problemSchema },
      },
    },
    async (request, reply) => {
      const result = await deps.auth.socialSignInUrl(
        request.body.provider,
        request.body.callbackURL,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send({ url: result.value });
    },
  );

  routes.post(
    "/v1/auth/sign-out",
    {
      schema: {
        tags: ["Auth"],
        summary: "End the current session",
        response: {
          200: z.object({ status: z.literal("SIGNED_OUT") }),
          401: problemSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.session === null) throw authRequired();
      const cookies = await deps.auth.signOut(toHeaders(request.headers));
      for (const cookie of cookies) reply.header("set-cookie", cookie);
      return reply.code(200).send({ status: "SIGNED_OUT" as const });
    },
  );

  routes.get(
    "/v1/auth/session",
    {
      schema: {
        tags: ["Auth"],
        summary: "Current session + user",
        response: { 200: sessionInfoSchema, 401: problemSchema },
      },
    },
    async (request, reply) => {
      if (request.session === null) throw authRequired();
      return reply.code(200).send(toSessionInfo(request.session));
    },
  );

  // Everything else under /v1/auth belongs to the auth library: OAuth redirects, provider
  // callbacks, verification links. Static routes above win over this wildcard.
  app.all("/v1/auth/*", { schema: { hide: true } }, async (request, reply) => {
    const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
    const proxied = new Request(url, {
      method: request.method,
      headers: toHeaders(request.headers),
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: JSON.stringify(request.body ?? {}) }),
    });

    const response = await deps.auth.handle(proxied);
    reply.code(response.status);
    for (const cookie of response.headers.getSetCookie()) reply.header("set-cookie", cookie);
    for (const [key, value] of response.headers.entries()) {
      if (key.toLowerCase() === "set-cookie") continue;
      reply.header(key, value);
    }
    const text = await response.text();
    return reply.send(text.length === 0 ? null : text);
  });
}
