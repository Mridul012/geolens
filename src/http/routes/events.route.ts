/**
 * The "what changed" feed (docs/API.md §3 — History group).
 *
 * Cursor-paginated over an append-only table: offset pagination dies on `events` first
 * (docs/Backend.md §12), so there is no page number and no total.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { cursorQuerySchema, paginatedSchema, projectIdParamSchema } from "../../contracts/api/common.js";
import { eventSchema } from "../../contracts/api/snapshots.js";
import { problemSchema } from "../../contracts/api/errors.js";
import { listEvents, type ReadEventsDeps } from "../../application/history/read-events.js";

export function registerEventRoutes(app: FastifyInstance, deps: ReadEventsDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/projects/:projectId/events",
    {
      schema: {
        tags: ["History"],
        summary: 'The "what changed" feed',
        params: projectIdParamSchema,
        querystring: cursorQuerySchema.extend({ kind: z.string().min(1).max(64).optional() }),
        response: { 200: paginatedSchema(eventSchema), 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listEvents(deps, {
        projectId: request.params.projectId,
        userId: session.user.id,
        limit: request.query.limit,
        cursor: request.query.cursor,
        kind: request.query.kind,
      });
      if (!result.ok) throw result.error;
      return reply
        .code(200)
        .send({ data: [...result.value.data], nextCursor: result.value.nextCursor });
    },
  );
}
