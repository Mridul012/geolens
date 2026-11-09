/** Prompt-run routes (docs/API.md §3 — Prompt Tracking). */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  promptResultListSchema,
  promptResultQuerySchema,
  promptRunListQuerySchema,
  promptRunListSchema,
  promptRunSchema,
  promptRunTrendSchema,
} from "../../contracts/api/prompt-runs.js";
import { projectIdParamSchema, uuidSchema } from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import { validationFailed } from "../../domain/shared/app-error.js";
import {
  startPromptRun,
  type StartPromptRunDeps,
} from "../../application/prompt-sim/start-prompt-run.js";
import {
  getPromptRun,
  listPromptResults,
  listPromptRuns,
  promptRunTrend,
  type ReadPromptRunsDeps,
} from "../../application/prompt-sim/read-prompt-runs.js";
import type { ProgressStore } from "../../application/ports/progress-store.port.js";
import type { IdempotencyGate } from "../plugins/idempotency.js";
import { streamSse } from "../sse/stream.js";

export interface PromptRunRouteDeps extends StartPromptRunDeps, ReadPromptRunsDeps {
  readonly idempotency: IdempotencyGate;
  readonly progress: ProgressStore;
  readonly baseUrl: string;
}

/** Runs shown on the trend chart. */
const TREND_LIMIT = 30;

export function registerPromptRunRoutes(app: FastifyInstance, deps: PromptRunRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/v1/projects/:projectId/prompt-runs",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Trigger an on-demand run across configured engines",
        params: projectIdParamSchema,
        response: {
          202: promptRunSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        // A run spends real money at real providers, so a double-clicked button must not
        // buy the same measurement twice (docs/API.md §4.4).
        throw validationFailed([
          { path: "Idempotency-Key", message: "This header is required." },
        ]);
      }

      const body = {};
      const replay = await deps.idempotency.begin(
        "prompt-runs",
        session.user.id,
        idempotencyKey,
        body,
      );
      if (replay !== null) {
        const original = promptRunSchema.parse(replay);
        reply.header(
          "location",
          `${deps.baseUrl}/v1/projects/${request.params.projectId}/prompt-runs/${original.id}`,
        );
        return reply.code(202).send(original);
      }

      try {
        const result = await startPromptRun(deps, {
          projectId: request.params.projectId,
          userId: session.user.id,
          requestId: String(request.id),
        });
        if (!result.ok) {
          await deps.idempotency.abandon("prompt-runs", session.user.id, idempotencyKey);
          throw result.error;
        }

        await deps.idempotency.finish(
          "prompt-runs",
          session.user.id,
          idempotencyKey,
          body,
          result.value,
        );
        reply.header(
          "location",
          `${deps.baseUrl}/v1/projects/${request.params.projectId}/prompt-runs/${result.value.id}`,
        );
        return reply.code(202).send(result.value);
      } catch (error) {
        await deps.idempotency.abandon("prompt-runs", session.user.id, idempotencyKey);
        throw error;
      }
    },
  );

  routes.get(
    "/v1/projects/:projectId/prompt-runs",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Run history",
        params: projectIdParamSchema,
        querystring: promptRunListQuerySchema,
        response: { 200: promptRunListSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listPromptRuns(deps, request.params.projectId, session.user.id, {
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      if (!result.ok) throw result.error;
      return reply
        .code(200)
        .send({ data: [...result.value.data], nextCursor: result.value.nextCursor });
    },
  );

  routes.get(
    "/v1/projects/:projectId/prompt-runs/trend",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Mention and citation trend, per engine, oldest first",
        params: projectIdParamSchema,
        response: {
          200: promptRunTrendSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await promptRunTrend(
        deps,
        request.params.projectId,
        session.user.id,
        TREND_LIMIT,
      );
      if (!result.ok) throw result.error;
      return reply
        .code(200)
        .send({ data: result.value.map((point) => ({ ...point, perEngine: [...point.perEngine] })) });
    },
  );

  routes.get(
    "/v1/projects/:projectId/prompt-runs/:runId",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Run detail — aggregate metrics, per-engine breakdown",
        params: projectIdParamSchema.extend({ runId: uuidSchema }),
        response: { 200: promptRunSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getPromptRun(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.runId,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId/prompt-runs/:runId/results",
    {
      schema: {
        tags: ["Prompt Tracking"],
        summary: "Per-cell results (prompt × engine × sample) with the answers as evidence",
        params: projectIdParamSchema.extend({ runId: uuidSchema }),
        querystring: promptResultQuerySchema,
        response: { 200: promptResultListSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listPromptResults(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.runId,
        {
          limit: request.query.limit,
          cursor: request.query.cursor,
          engine: request.query.engine,
          promptTemplateId: request.query.promptTemplateId,
        },
      );
      if (!result.ok) throw result.error;
      return reply
        .code(200)
        .send({ data: [...result.value.data], nextCursor: result.value.nextCursor });
    },
  );

  // SSE carries no response schema; the envelope is asserted by the e2e suite.
  app.get<{ Params: { projectId: string; runId: string } }>(
    "/v1/projects/:projectId/prompt-runs/:runId/progress",
    { schema: { hide: true } },
    async (request, reply) => {
      const session = app.requireSession(request);
      const run = await getPromptRun(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.runId,
      );
      if (!run.ok) throw run.error;

      const TERMINAL = ["COMPLETED", "COMPLETED_DEGRADED", "FAILED"];
      let lastSignature = "";

      await streamSse(request, reply, {
        poll: async () => {
          const events: Array<{ event: string; data: unknown }> = [];
          const progress = await deps.progress.getPromptRunProgress(request.params.runId);

          if (progress !== null) {
            const signature = `${progress.cellsDone}/${progress.cellsTotal}`;
            if (signature !== lastSignature) {
              lastSignature = signature;
              events.push({
                event: "progress",
                data: { cellsDone: progress.cellsDone, cellsTotal: progress.cellsTotal },
              });
            }
            if (progress.status !== null) {
              events.push({ event: "done", data: { status: progress.status } });
              return { events, done: true };
            }
          }

          // Postgres is authoritative; Redis is a convenience. Reconciling every tick is
          // what stops the stream hanging when a run reaches a terminal state without the
          // progress hash catching up.
          const current = await getPromptRun(
            deps,
            request.params.projectId,
            session.user.id,
            request.params.runId,
          );
          if (current.ok && TERMINAL.includes(current.value.status)) {
            events.push({ event: "done", data: { status: current.value.status } });
            return { events, done: true };
          }

          return { events, done: false };
        },
      });
    },
  );
}
