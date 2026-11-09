/** `GET /v1/me` — profile, plan and usage vs limits (docs/API.md §3). */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getCurrentUser, type GetCurrentUserDeps } from "../../application/auth/get-current-user.js";
import { meSchema } from "../../contracts/api/auth.js";
import { problemSchema } from "../../contracts/api/errors.js";

export function registerMeRoute(app: FastifyInstance, deps: GetCurrentUserDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/me",
    {
      schema: {
        tags: ["Auth"],
        summary: "Profile, plan, and usage vs limits",
        response: { 200: meSchema, 401: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getCurrentUser(deps, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );
}
