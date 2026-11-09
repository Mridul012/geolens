/**
 * Mounts the queue dashboard behind admin basic auth (docs/Backend.md §15).
 *
 * Deliberately opt-in: with no admin credentials configured the route is never registered
 * at all, so a misconfigured environment exposes nothing rather than exposing a dashboard
 * with a default password. The dashboard itself is an opaque plugin built by the
 * composition root — this file never learns which queue library is behind it.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyPluginCallback } from "fastify";

export interface AdminQueuesOptions {
  readonly basePath: string;
  readonly username: string;
  readonly password: string;
  readonly dashboard: FastifyPluginCallback;
}

/** Constant-time compare so the credential check cannot be probed byte by byte. */
function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function registerAdminQueues(
  app: FastifyInstance,
  options: AdminQueuesOptions,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      const header = request.headers.authorization ?? "";
      const [scheme, encoded] = header.split(" ");
      const unauthorized = async (): Promise<void> => {
        await reply
          .code(401)
          .header("www-authenticate", 'Basic realm="geolens-admin"')
          .send({ error: "unauthorized" });
      };

      if (scheme !== "Basic" || encoded === undefined) {
        await unauthorized();
        return;
      }
      const [username = "", password = ""] = Buffer.from(encoded, "base64")
        .toString("utf8")
        .split(":");
      if (!matches(username, options.username) || !matches(password, options.password)) {
        await unauthorized();
      }
    });

    await scope.register(options.dashboard, { prefix: options.basePath });
  });
}
