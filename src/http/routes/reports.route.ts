/** Report routes (docs/API.md §3 — Reports). */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { generateReportSchema, reportSchema } from "../../contracts/api/reports.js";
import {
  cursorQuerySchema,
  paginatedSchema,
  projectIdParamSchema,
  uuidSchema,
} from "../../contracts/api/common.js";
import { problemSchema } from "../../contracts/api/errors.js";
import { validationFailed } from "../../domain/shared/app-error.js";
import { startReport, type StartReportDeps } from "../../application/reports/start-report.js";
import { getReport, listReports, type ReadReportsDeps } from "../../application/reports/read-reports.js";
import { downloadReport, type DownloadReportDeps } from "../../application/reports/download-report.js";
import type { IdempotencyGate } from "../plugins/idempotency.js";

export interface ReportRouteDeps extends StartReportDeps, ReadReportsDeps, DownloadReportDeps {
  readonly idempotency: IdempotencyGate;
  readonly baseUrl: string;
}

export function registerReportRoutes(app: FastifyInstance, deps: ReportRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    "/v1/projects/:projectId/reports",
    {
      schema: {
        tags: ["Reports"],
        summary: "Generate a PDF report from the latest completed inputs",
        params: projectIdParamSchema,
        response: {
          202: reportSchema,
          400: problemSchema,
          401: problemSchema,
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
        throw validationFailed([
          { path: "Idempotency-Key", message: "This header is required." },
        ]);
      }

      const parsedBody = generateReportSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        throw validationFailed(
          parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      const body = parsedBody.data;
      const replay = await deps.idempotency.begin("reports", session.user.id, idempotencyKey, body);
      if (replay !== null) {
        const original = reportSchema.parse(replay);
        reply.header(
          "location",
          `${deps.baseUrl}/v1/projects/${request.params.projectId}/reports/${original.id}`,
        );
        return reply.code(202).send(original);
      }

      try {
        const result = await startReport(deps, {
          projectId: request.params.projectId,
          userId: session.user.id,
          sections: body.sections,
          requestId: String(request.id),
        });
        if (!result.ok) {
          await deps.idempotency.abandon("reports", session.user.id, idempotencyKey);
          throw result.error;
        }

        await deps.idempotency.finish(
          "reports",
          session.user.id,
          idempotencyKey,
          body,
          result.value,
        );
        reply.header(
          "location",
          `${deps.baseUrl}/v1/projects/${request.params.projectId}/reports/${result.value.id}`,
        );
        return reply.code(202).send(result.value);
      } catch (error) {
        await deps.idempotency.abandon("reports", session.user.id, idempotencyKey);
        throw error;
      }
    },
  );

  routes.get(
    "/v1/projects/:projectId/reports",
    {
      schema: {
        tags: ["Reports"],
        summary: "List reports, newest first",
        params: projectIdParamSchema,
        querystring: cursorQuerySchema,
        response: { 200: paginatedSchema(reportSchema), 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await listReports(deps, {
        projectId: request.params.projectId,
        userId: session.user.id,
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
    "/v1/projects/:projectId/reports/:reportId",
    {
      schema: {
        tags: ["Reports"],
        summary: "Report status (poll after the 202)",
        params: projectIdParamSchema.extend({ reportId: uuidSchema }),
        response: { 200: reportSchema, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await getReport(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.reportId,
      );
      if (!result.ok) throw result.error;
      return reply.code(200).send(result.value);
    },
  );

  routes.get(
    "/v1/projects/:projectId/reports/:reportId/download",
    {
      schema: {
        tags: ["Reports"],
        summary: "Redirect to a short-lived signed URL (API never proxies bytes)",
        params: projectIdParamSchema.extend({ reportId: uuidSchema }),
        response: { 401: problemSchema, 404: problemSchema, 409: problemSchema },
      },
    },
    async (request, reply) => {
      const session = app.requireSession(request);
      const result = await downloadReport(
        deps,
        request.params.projectId,
        session.user.id,
        request.params.reportId,
      );
      if (!result.ok) throw result.error;
      return reply.redirect(result.value, 302);
    },
  );
}
