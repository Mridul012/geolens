/**
 * Crawler routes (docs/API.md §3 — Crawler group).
 *
 * `POST /crawls` follows the async pattern the contract mandates: 202 + Location + SSE,
 * with a required Idempotency-Key. The handler never crawls — it enqueues.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { crawlSchema } from "../../contracts/api/crawls.js";
import {
  cursorQuerySchema,
  paginatedSchema,
  projectIdParamSchema,
  uuidSchema,
} from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import {
  pageSnapshotDetailSchema,
  pageSnapshotSummarySchema,
} from "../../contracts/api/snapshots.js";
import { validationFailed } from "../../domain/shared/app-error.js";
import { startCrawl, type StartCrawlDeps } from "../../application/crawls/start-crawl.js";
import {
  cancelCrawl,
  getCrawl,
  listCrawlPages,
  listCrawls,
  type ReadCrawlsDeps,
} from "../../application/crawls/read-crawls.js";
import { getSnapshot, type ReadSnapshotDeps } from "../../application/crawls/read-snapshot.js";
import { getAnalysis, type ReadAnalysisDeps } from "../../application/analysis/read-analysis.js";
import { analysisReportSchema } from "../../contracts/api/analysis.js";
import { streamSse } from "../sse/stream.js";
import type { IdempotencyGate } from "../plugins/idempotency.js";

export interface CrawlRouteDeps
  extends StartCrawlDeps,
    ReadCrawlsDeps,
    ReadSnapshotDeps,
    ReadAnalysisDeps {
  readonly idempotency: IdempotencyGate;
  readonly baseUrl: string;
}

const crawlIdParamSchema = projectIdParamSchema.extend({ crawlId: uuidSchema });

const startCrawlBodySchema = z
  .object({ siteId: uuidSchema.optional() })
  .optional()
  .default({});

export function registerCrawlRoutes(app: FastifyInstance, deps: CrawlRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/v1/projects/:projectId/crawls",
    {
      config: { rateLimitBucket: "expensive" },
      schema: {
        tags: ["Crawler"],
        summary: "Start a crawl (defaults to the OWN site)",
        params: projectIdParamSchema,
        body: startCrawlBodySchema,
        response: {
          202: crawlSchema,
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
        // Required, not optional: optional idempotency is idempotency that isn't there
        // when it matters (docs/API.md §4.4).
        throw validationFailed([
          { path: "Idempotency-Key", message: "This header is required." },
        ]);
      }

      const body = request.body ?? {};
      const replay = await deps.idempotency.begin("crawls", session.user.id, idempotencyKey, body);
      if (replay !== null) {
        // Re-validated on the way out: a stored response from an older deploy that no
        // longer matches the contract must fail loudly, not be replayed as-is.
        const original = crawlSchema.parse(replay);
        reply.header(
          "location",
          `${deps.baseUrl}/v1/projects/${request.params.projectId}/crawls/${original.id}`,
        );
        return reply.code(202).send(original);
      }

      try {
        const result = await startCrawl(deps, {
          projectId: request.params.projectId,
          userId: session.user.id,
          siteId: body.siteId,
          requestId: String(request.id),
        });
        if (!result.ok) {
          await deps.idempotency.abandon("crawls", session.user.id, idempotencyKey);
          throw result.error;
        }

        await deps.idempotency.finish(
          "crawls",
          session.user.id,
          idempotencyKey,
          body,
          result.value,
        );
        reply.header(
          "location",
          `${deps.baseUrl}/v1/projects/${request.params.projectId}/crawls/${result.value.id}`,
        );
        return reply.code(202).send(result.value);
      } catch (error) {
        await deps.idempotency.abandon("crawls", session.user.id, idempotencyKey);
        throw error;
      }
    },
  );

  routes.get(
    "/v1/projects/:projectId/crawls",
    {
      schema: {
        tags: ["Crawler"],
        summary: "Crawl history for the project",
        params: projectIdParamSchema,
        querystring: cursorQuerySchema.extend({ siteId: uuidSchema.optional() }),
        response: { 200: paginatedSchema(crawlSchema), 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listCrawls(deps, {
        projectId: request.params.projectId,
        userId: session.user.id,
        limit: request.query.limit,
        cursor: request.query.cursor,
        siteId: request.query.siteId,
      });
      if (!result.ok) throw result.error;
      return reply
        .code(200)
        .send({ data: [...result.value.data], nextCursor: result.value.nextCursor });
    },
  );

  routes.get(
    "/v1/projects/:projectId/crawls/:crawlId",
    {
      schema: {
        tags: ["Crawler"],
        summary: "Crawl detail — status, stats, degradation flags",
        params: crawlIdParamSchema,
        response: { 200: crawlSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getCrawl(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.crawlId,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.post(
    "/v1/projects/:projectId/crawls/:crawlId/cancel",
    {
      schema: {
        tags: ["Crawler"],
        summary: "Cancel an active crawl",
        params: crawlIdParamSchema,
        response: {
          200: crawlSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await cancelCrawl(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.crawlId,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId/crawls/:crawlId/pages",
    {
      schema: {
        tags: ["Crawler"],
        summary: "Page snapshots captured by a crawl",
        params: crawlIdParamSchema,
        querystring: cursorQuerySchema.extend({
          changed: z
            .enum(["true", "false"])
            .optional()
            .transform((value) => (value === undefined ? undefined : value === "true")),
        }),
        response: {
          200: paginatedSchema(pageSnapshotSummarySchema),
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listCrawlPages(deps, {
        projectId: request.params.projectId,
        userId: session.user.id,
        crawlId: request.params.crawlId,
        limit: request.query.limit,
        cursor: request.query.cursor,
        changed: request.query.changed,
      });
      if (!result.ok) throw result.error;
      return reply
        .code(200)
        .send({ data: [...result.value.data], nextCursor: result.value.nextCursor });
    },
  );

  routes.get(
    "/v1/projects/:projectId/crawls/:crawlId/analysis",
    {
      schema: {
        tags: ["Analysis"],
        summary: "Full analysis for a crawl — access check, retrievability, issues",
        params: crawlIdParamSchema,
        response: {
          200: analysisReportSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getAnalysis(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.crawlId,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId/snapshots/:snapshotId",
    {
      schema: {
        tags: ["Crawler"],
        summary: "Snapshot detail — the evidence view behind analysis and recommendations",
        params: projectIdParamSchema.extend({ snapshotId: uuidSchema }),
        response: { 200: pageSnapshotDetailSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getSnapshot(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.snapshotId,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  // SSE is documented as `text/event-stream`, so it carries no response schema; the
  // envelope is asserted by the e2e suite instead.
  app.get<{ Params: { projectId: string; crawlId: string } }>(
    "/v1/projects/:projectId/crawls/:crawlId/progress",
    { schema: { hide: true } },
    async (request, reply) => {
      const session = app.requireSession(request);
      const crawl = await getCrawl(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.crawlId,
      );
      if (!crawl.ok) throw crawl.error;

      const TERMINAL = ["COMPLETED", "COMPLETED_DEGRADED", "FAILED", "CANCELED"];
      let lastSignature = "";

      await streamSse(request, reply, {
        poll: async () => {
          const events: Array<{ event: string; data: unknown }> = [];
          const progress = await deps.progress.getCrawlProgress(request.params.crawlId);

          if (progress !== null) {
            // Only emit when something actually moved, so a reconnecting client gets one
            // snapshot rather than the same frame every 1.5s.
            const signature = `${progress.stage}|${progress.message}|${progress.pagesCrawled}|${progress.pagesFound}`;
            if (signature !== lastSignature) {
              lastSignature = signature;
              events.push({ event: "stage", data: { message: progress.message } });
              events.push({
                event: "progress",
                data: {
                  pagesFound: progress.pagesFound,
                  pagesCrawled: progress.pagesCrawled,
                  currentUrl: progress.currentUrl,
                  etaSeconds: progress.etaSeconds,
                },
              });
            }
            if (progress.status !== null) {
              events.push({ event: "done", data: { status: progress.status } });
              return { events, done: true };
            }
          }

          // Postgres is authoritative; Redis is a convenience (Engineering-Rules §7).
          // Reconciling on every tick is what stops the stream hanging forever when a
          // crawl reaches a terminal state without the progress hash being updated — a
          // killed worker, a Redis flush, or a cancel that beat the worker to it. The read
          // is a primary-key lookup, and only runs while we still believe it is running.
          const current = await deps.crawls.findInProject(
            request.params.projectId,
            request.params.crawlId,
          );
          if (current !== null && TERMINAL.includes(current.status)) {
            if (events.length === 0) {
              events.push({
                event: "stage",
                data: { message: `Crawl ${current.status.toLowerCase().replace("_", " ")}.` },
              });
              events.push({
                event: "progress",
                data: {
                  pagesFound: current.stats.pagesDiscovered,
                  pagesCrawled: current.stats.pagesCrawled,
                  currentUrl: null,
                  etaSeconds: 0,
                },
              });
            }
            events.push({ event: "done", data: { status: current.status } });
            return { events, done: true };
          }

          return { events, done: false };
        },
      });
    },
  );
}
