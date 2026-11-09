/**
 * Session resolution for every request, and the guard routes lean on.
 *
 * Ownership failures return 404 rather than 403 (docs/API.md §4.2), but *authentication*
 * failures are honest 401s — there is no resource to hide yet.
 */
import type { FastifyInstance } from "fastify";
import type { AuthGateway, AuthSession } from "../../application/ports/auth.port.js";
import { authRequired } from "../../domain/shared/app-error.js";

export interface AuthPluginOptions {
  readonly auth: AuthGateway;
}

/** Fastify exposes headers as a plain object; the port speaks web-standard Headers. */
export function toHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorateRequest("session", null);

  app.decorate("requireSession", (request): AuthSession => {
    if (request.session === null) throw authRequired();
    return request.session;
  });

  app.addHook("onRequest", async (request) => {
    // Resolved once per request so guards, rate-limit subjects and logs all agree.
    request.session = await options.auth.resolveSession(toHeaders(request.headers));
  });
}
