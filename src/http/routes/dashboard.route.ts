/** Dashboard and score routes (docs/API.md §3 — Analysis group). */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { dashboardSchema } from "../../contracts/api/dashboard.js";
import {
  scoreBreakdownSchema,
  scoreListQuerySchema,
  scoreListSchema,
} from "../../contracts/api/dashboard-routes.js";
import { projectIdParamSchema } from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import {
  readDashboard,
  type ReadDashboardDeps,
} from "../../application/dashboard/read-dashboard.js";
import {
  latestScore,
  listScores,
  type ReadScoresDeps,
} from "../../application/scoring/read-scores.js";

export interface DashboardRouteDeps {
  readonly dashboard: ReadDashboardDeps;
  readonly scores: ReadScoresDeps;
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/projects/:projectId/dashboard",
    {
      schema: {
        tags: ["Analysis"],
        summary: "The single precomputed dashboard read (Redis-cached; never computes)",
        params: projectIdParamSchema,
        response: { 200: dashboardSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await readDashboard(deps.dashboard, request.params.projectId, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId/scores",
    {
      schema: {
        tags: ["Analysis"],
        summary: "Score history for trend charts",
        params: projectIdParamSchema,
        querystring: scoreListQuerySchema,
        response: { 200: scoreListSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listScores(deps.scores, request.params.projectId, session.user.id, {
        limit: request.query.limit,
        cursor: request.query.cursor,
        from: request.query.from,
        to: request.query.to,
      });
      if (!result.ok) throw result.error;
      return reply.code(200).send({ data: [...result.value.data], nextCursor: result.value.nextCursor });
    },
  );

  routes.get(
    "/v1/projects/:projectId/scores/latest",
    {
      schema: {
        tags: ["Analysis"],
        summary: "Latest score with full component breakdown (the drawer)",
        params: projectIdParamSchema,
        // 200 with a null score, never 404: "no score yet" is a state, not a missing
        // resource, and the client renders "score pending" for it.
        response: { 200: scoreBreakdownSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await latestScore(deps.scores, request.params.projectId, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );
}
