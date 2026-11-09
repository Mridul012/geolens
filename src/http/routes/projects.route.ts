/**
 * Projects and competitors (docs/API.md §3). Controllers stay thin: validate → resolve the
 * session → call exactly one use case → map the result (Engineering-Rules §2.2).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  addCompetitorBodySchema,
  competitorListSchema,
  createProjectBodySchema,
  deleteProjectResponseSchema,
  projectDetailSchema,
  projectSchema,
  siteSchema,
  updateProjectBodySchema,
} from "../../contracts/api/projects.js";
import { cursorQuerySchema, paginatedSchema, projectIdParamSchema, uuidSchema } from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import { createProject, type CreateProjectDeps } from "../../application/projects/create-project.js";
import { getProject, listProjects, type ReadProjectsDeps } from "../../application/projects/read-projects.js";
import { updateProject, type UpdateProjectDeps } from "../../application/projects/update-project.js";
import { deleteProject, type DeleteProjectDeps } from "../../application/projects/delete-project.js";
import {
  addCompetitor,
  listCompetitors,
  removeCompetitor,
  type CompetitorDeps,
} from "../../application/projects/competitors.js";

export interface ProjectRouteDeps
  extends CreateProjectDeps,
    ReadProjectsDeps,
    UpdateProjectDeps,
    DeleteProjectDeps,
    CompetitorDeps {}

const siteIdParamSchema = projectIdParamSchema.extend({ siteId: uuidSchema });

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/projects",
    {
      schema: {
        tags: ["Projects"],
        summary: "List projects",
        querystring: cursorQuerySchema,
        response: { 200: paginatedSchema(projectSchema), 401: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const page = await listProjects(
        deps,
        session.user.id,
        request.query.limit,
        request.query.cursor,
      );
      return reply.code(200).send({ data: [...page.data], nextCursor: page.nextCursor });
    },
  );

  routes.post(
    "/v1/projects",
    {
      schema: {
        tags: ["Projects"],
        summary: "Create a project (creates the OWN site; optional competitor)",
        body: createProjectBodySchema,
        response: {
          201: projectSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await createProject(deps, {
        userId: session.user.id,
        name: request.body.name,
        url: request.body.url,
        competitorUrl: request.body.competitorUrl,
        timezone: request.body.timezone,
      });
      if (!result.ok) throw result.error;
      return reply.code(201).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId",
    {
      schema: {
        tags: ["Projects"],
        summary: "Project detail (sites, latest crawl, latest score)",
        params: projectIdParamSchema,
        response: { 200: projectDetailSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getProject(deps, request.params.projectId, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.patch(
    "/v1/projects/:projectId",
    {
      schema: {
        tags: ["Projects"],
        summary: "Update name, timezone, or archive state",
        params: projectIdParamSchema,
        body: updateProjectBodySchema,
        response: {
          200: projectSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await updateProject(
        deps,
        request.params.projectId,
        session.user.id,
        request.body,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.delete(
    "/v1/projects/:projectId",
    {
      schema: {
        tags: ["Projects"],
        summary: "Soft-delete the project; derived data is purged asynchronously",
        params: projectIdParamSchema,
        response: { 202: deleteProjectResponseSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await deleteProject(deps, request.params.projectId, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(202).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId/competitors",
    {
      schema: {
        tags: ["Competitors"],
        summary: "List competitor sites",
        params: projectIdParamSchema,
        response: { 200: competitorListSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listCompetitors(deps, request.params.projectId, session.user.id);
      if (!result.ok) throw result.error;
      return reply.code(200).send({ data: [...result.value] });
    },
  );

  routes.post(
    "/v1/projects/:projectId/competitors",
    {
      schema: {
        tags: ["Competitors"],
        summary: "Add a competitor site",
        params: projectIdParamSchema,
        body: addCompetitorBodySchema,
        response: {
          201: siteSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await addCompetitor(deps, request.params.projectId, session.user.id, {
        url: request.body.url,
        name: request.body.name,
      });
      if (!result.ok) throw result.error;
      return reply.code(201).send(result.value);
    },
  );

  routes.delete(
    "/v1/projects/:projectId/competitors/:siteId",
    {
      schema: {
        tags: ["Competitors"],
        summary: "Remove a competitor",
        params: siteIdParamSchema,
        response: {
          204: z.null(),
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await removeCompetitor(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.siteId,
      );
      if (!result.ok) throw result.error;
      return reply.code(204).send(null);
    },
  );
}
