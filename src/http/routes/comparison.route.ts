/** The comparison route (docs/API.md §3 — Competitors). */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { comparisonSchema } from "../../contracts/api/comparison.js";
import { projectIdParamSchema } from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import {
  readComparison,
  type ReadComparisonDeps,
} from "../../application/analysis/read-comparison.js";

export function registerComparisonRoutes(app: FastifyInstance, deps: ReadComparisonDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/projects/:projectId/comparison",
    {
      schema: {
        tags: ["Competitors"],
        summary: "Side-by-side comparison (latest completed crawls + latest prompt run)",
        params: projectIdParamSchema,
        response: { 200: comparisonSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await readComparison(deps, request.params.projectId, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );
}
