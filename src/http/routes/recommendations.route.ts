/** Recommendation routes (docs/API.md §3 — Recommendations group). */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  recommendationDetailSchema,
  recommendationListQuerySchema,
  recommendationListSchema,
  recommendationSchema,
  updateRecommendationBodySchema,
} from "../../contracts/api/recommendations.js";
import { projectIdParamSchema, uuidSchema } from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import {
  getRecommendation,
  listRecommendations,
  updateRecommendationStatus,
  type RecommendationDeps,
} from "../../application/recommendations/read-recommendations.js";

export function registerRecommendationRoutes(
  app: FastifyInstance,
  deps: RecommendationDeps,
): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/projects/:projectId/recommendations",
    {
      schema: {
        tags: ["Recommendations"],
        summary: "Recommendations, ranked by impact ÷ difficulty",
        params: projectIdParamSchema,
        querystring: recommendationListQuerySchema,
        response: { 200: recommendationListSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listRecommendations(deps, request.params.projectId, session.user.id, {
        limit: request.query.limit,
        cursor: request.query.cursor,
        status: request.query.status,
        priority: request.query.priority,
      });
      if (!result.ok) throw result.error;
      return reply
        .code(200)
        .send({ data: [...result.value.data], nextCursor: result.value.nextCursor });
    },
  );

  routes.get(
    "/v1/projects/:projectId/recommendations/:recId",
    {
      schema: {
        tags: ["Recommendations"],
        summary: "Recommendation detail with expanded evidence links",
        params: projectIdParamSchema.extend({ recId: uuidSchema }),
        response: { 200: recommendationDetailSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getRecommendation(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.recId,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.patch(
    "/v1/projects/:projectId/recommendations/:recId",
    {
      schema: {
        tags: ["Recommendations"],
        summary: "Transition status (OPEN→DONE, OPEN→DISMISSED, DONE/DISMISSED→OPEN)",
        params: projectIdParamSchema.extend({ recId: uuidSchema }),
        // The body schema admits only the three client-owned statuses, so VALIDATED and
        // REGRESSED are rejected at the edge with a 400 rather than reaching a use case.
        body: updateRecommendationBodySchema,
        response: {
          200: recommendationSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await updateRecommendationStatus(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.recId,
        request.body.status,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );
}
