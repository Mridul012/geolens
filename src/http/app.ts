/**
 * The Fastify application factory. Tests build the same app the process does and drive it
 * with `app.inject()` (Engineering-Rules §9) — there is no second wiring path.
 *
 * Plugin order matters and is deliberate: security → request context → error handler →
 * auth (so the rate limiter can key on a resolved user) → rate limit → routes.
 */
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyPluginCallback,
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import swagger from "@fastify/swagger";
import type { AuthGateway } from "../application/ports/auth.port.js";
import type { RateLimiter, RateLimitRule } from "../application/ports/rate-limiter.port.js";
import type { GetCurrentUserDeps } from "../application/auth/get-current-user.js";
import { registerHealthRoute, type HealthDependencies } from "./routes/health.route.js";
import { registerRequestContext, newRequestId } from "./plugins/request-context.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerSecurity } from "./plugins/security.js";
import { registerRateLimit, type BucketName } from "./plugins/rate-limit.js";
import { registerAuth } from "./plugins/auth.js";
import { registerAuthRoutes } from "./routes/auth.route.js";
import { registerMeRoute } from "./routes/me.route.js";
import { registerProjectRoutes, type ProjectRouteDeps } from "./routes/projects.route.js";
import { registerAdminQueues } from "./plugins/admin-queues.js";
import { registerCrawlRoutes, type CrawlRouteDeps } from "./routes/crawls.route.js";
import { registerEventRoutes } from "./routes/events.route.js";
import { registerTopicRoutes, type TopicRouteDeps } from "./routes/topics.route.js";
import {
  registerDashboardRoutes,
  type DashboardRouteDeps,
} from "./routes/dashboard.route.js";
import { registerRecommendationRoutes } from "./routes/recommendations.route.js";
import { registerPromptRoutes } from "./routes/prompts.route.js";
import {
  registerPromptRunRoutes,
  type PromptRunRouteDeps,
} from "./routes/prompt-runs.route.js";
import { registerComparisonRoutes } from "./routes/comparison.route.js";
import { registerReportRoutes, type ReportRouteDeps } from "./routes/reports.route.js";
import { registerBillingRoutes, type BillingRouteDeps } from "./routes/billing.route.js";
import { registerWebhookRoutes, type WebhookRouteDeps } from "./routes/webhooks.route.js";
import type { PromptDeps } from "../application/prompt-sim/manage-prompts.js";
import type { RecommendationDeps } from "../application/recommendations/read-recommendations.js";
import type { ReadEventsDeps } from "../application/history/read-events.js";
import type { ReadComparisonDeps } from "../application/analysis/read-comparison.js";
import "./types.js";

export interface AppDependencies {
  readonly logger: FastifyBaseLogger;
  readonly auth: AuthGateway;
  readonly rateLimiter: RateLimiter;
  readonly rateLimitRules: Readonly<Record<BucketName, RateLimitRule>>;
  readonly me: GetCurrentUserDeps;
  readonly projects: ProjectRouteDeps;
  readonly crawls: CrawlRouteDeps;
  readonly events: ReadEventsDeps;
  readonly topics: TopicRouteDeps;
  readonly analytics: DashboardRouteDeps;
  readonly recommendations: RecommendationDeps;
  readonly prompts: PromptDeps;
  readonly promptRuns: PromptRunRouteDeps;
  readonly comparison: ReadComparisonDeps;
  readonly reports: ReportRouteDeps;
  readonly billing: BillingRouteDeps;
  readonly webhooks: WebhookRouteDeps;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly health?: HealthDependencies;
  /** Queue dashboard mount; omitted when admin credentials are unset. */
  readonly admin?: {
    readonly username: string;
    readonly password: string;
    readonly dashboard: FastifyPluginCallback;
  };
  readonly onUnexpected?: (error: unknown, context: Record<string, unknown>) => void;
}

export type App = FastifyInstance;

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
    genReqId: () => newRequestId(),
  }).withTypeProvider<ZodTypeProvider>();

  // Zod is the single source of truth for request and response shapes; the OpenAPI
  // document is generated from the very schemas that validate at runtime (§4).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await registerSecurity(app, {
    allowedOrigins: deps.allowedOrigins,
    originCheckExemptPaths: ["/v1/webhooks/"],
  });

  registerRequestContext(app);
  registerErrorHandler(app, {
    baseUrl: deps.baseUrl,
    ...(deps.onUnexpected === undefined ? {} : { onUnexpected: deps.onUnexpected }),
  });
  registerAuth(app, { auth: deps.auth });
  registerRateLimit(app, { limiter: deps.rateLimiter, rules: deps.rateLimitRules });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Vryse Lite API",
        version: "1.0.0-mvp",
        description:
          "AI visibility platform API. Cookie-session auth, project-scoped resources, cursor pagination, RFC-7807 errors, 202+SSE for async pipelines.",
      },
      servers: [{ url: deps.baseUrl }],
      components: {
        securitySchemes: {
          cookieAuth: { type: "apiKey", in: "cookie", name: "vryse.session" },
        },
      },
      security: [{ cookieAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  registerHealthRoute(app, deps.health ?? {});
  registerAuthRoutes(app, { auth: deps.auth });
  registerMeRoute(app, deps.me);
  registerProjectRoutes(app, deps.projects);
  registerCrawlRoutes(app, deps.crawls);
  registerEventRoutes(app, deps.events);
  registerTopicRoutes(app, deps.topics);
  registerDashboardRoutes(app, deps.analytics);
  registerRecommendationRoutes(app, deps.recommendations);
  registerPromptRoutes(app, deps.prompts);
  registerPromptRunRoutes(app, deps.promptRuns);
  registerComparisonRoutes(app, deps.comparison);
  registerReportRoutes(app, deps.reports);
  registerBillingRoutes(app, deps.billing);
  registerWebhookRoutes(app, deps.webhooks);

  app.get("/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  if (deps.admin !== undefined) {
    await registerAdminQueues(app, {
      basePath: "/admin/queues",
      username: deps.admin.username,
      password: deps.admin.password,
      dashboard: deps.admin.dashboard,
    });
  }

  await app.ready();
  return app;
}
