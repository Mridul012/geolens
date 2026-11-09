/** Topic routes (docs/API.md §3 — Analysis group). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createTopicBodySchema,
  topicListSchema,
  topicSchema,
  updateTopicBodySchema,
} from "../../contracts/api/topics.js";
import { topicCoverageResponseSchema } from "../../contracts/api/coverage.js";
import { projectIdParamSchema, uuidSchema } from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import {
  addTopic,
  listTopics,
  updateTopic,
  type TopicDeps,
} from "../../application/analysis/manage-topics.js";
import {
  readTopicCoverage,
  type ReadCoverageDeps,
} from "../../application/analysis/read-coverage.js";

export interface TopicRouteDeps {
  readonly topics: TopicDeps;
  readonly coverage: ReadCoverageDeps;
}

export function registerTopicRoutes(app: FastifyInstance, routeDeps: TopicRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const deps = routeDeps.topics;

  // Registered before the `:topicId` route for readability only — Fastify's router
  // already prefers the static segment over the parameter.
  routes.get(
    "/v1/projects/:projectId/topics/coverage",
    {
      schema: {
        tags: ["Analysis"],
        summary: "Topic coverage — own vs competitor (latest completed crawls), gaps ranked",
        params: projectIdParamSchema,
        response: { 200: topicCoverageResponseSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await readTopicCoverage(
        routeDeps.coverage,
        request.params.projectId,
        session.user.id,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId/topics",
    {
      schema: {
        tags: ["Analysis"],
        summary: "Taxonomy (active + archived)",
        params: projectIdParamSchema,
        querystring: z.object({ status: z.enum(["ACTIVE", "ARCHIVED"]).optional() }),
        response: { 200: topicListSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listTopics(
        deps,
        request.params.projectId,
        session.user.id,
        request.query.status,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send({ data: [...result.value] });
    },
  );

  routes.post(
    "/v1/projects/:projectId/topics",
    {
      schema: {
        tags: ["Analysis"],
        summary: "Add a custom topic",
        params: projectIdParamSchema,
        body: createTopicBodySchema,
        response: {
          201: topicSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await addTopic(deps, request.params.projectId, session.user.id, {
        label: request.body.label,
        description: request.body.description,
      });
      if (!result.ok) throw result.error;
      return reply.code(201).send(result.value);
    },
  );

  routes.patch(
    "/v1/projects/:projectId/topics/:topicId",
    {
      schema: {
        tags: ["Analysis"],
        summary: "Edit label/description, reorder, or archive",
        params: projectIdParamSchema.extend({ topicId: uuidSchema }),
        body: updateTopicBodySchema,
        response: {
          200: topicSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await updateTopic(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.topicId,
        request.body,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );
}
