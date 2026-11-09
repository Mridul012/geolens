/** Tracked prompt routes (docs/API.md §3 — Prompt Tracking). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createPromptBodySchema,
  promptListSchema,
  promptTemplateSchema,
  updatePromptBodySchema,
} from "../../contracts/api/prompts.js";
import { projectIdParamSchema, uuidSchema } from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import {
  addPrompt,
  listPrompts,
  updatePrompt,
  type PromptDeps,
} from "../../application/prompt-sim/manage-prompts.js";

export function registerPromptRoutes(app: FastifyInstance, deps: PromptDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    "/v1/projects/:projectId/prompts",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Tracked prompt templates",
        params: projectIdParamSchema,
        querystring: z.object({ status: z.enum(["ACTIVE", "ARCHIVED"]).optional() }),
        response: { 200: promptListSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listPrompts(
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
    "/v1/projects/:projectId/prompts",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Add a prompt to track",
        params: projectIdParamSchema,
        body: createPromptBodySchema,
        response: {
          201: promptTemplateSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await addPrompt(deps, request.params.projectId, session.user.id, {
        text: request.body.text,
        intent: request.body.intent,
        pinned: request.body.pinned,
      });
      if (!result.ok) throw result.error;
      return reply.code(201).send(result.value);
    },
  );

  routes.patch(
    "/v1/projects/:projectId/prompts/:promptId",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Pin or archive a prompt. Text is immutable — archive and create instead.",
        params: projectIdParamSchema.extend({ promptId: uuidSchema }),
        body: updatePromptBodySchema,
        response: {
          200: promptTemplateSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await updatePrompt(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.promptId,
        request.body,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );
}
