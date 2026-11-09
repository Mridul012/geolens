// Process entry for the `web` deployable (Backend §2). Owns boot order, signal handling
// and the composition root; the app factory itself stays dependency-injected and testable.
import { env } from "../config/env.js";
import { createContainer } from "../composition/container.js";
import { createProcessTelemetry } from "../composition/telemetry.js";
import { buildApp } from "./app.js";

const telemetry = createProcessTelemetry("api");
const logger = telemetry.logger;

async function main(): Promise<void> {
  const container = createContainer();
  const app = await buildApp({
    logger,
    auth: container.auth,
    rateLimiter: container.rateLimiter,
    rateLimitRules: container.rateLimitRules,
    me: container.me,
    projects: container.projects,
    crawls: container.crawls,
    events: container.events,
    topics: container.topics,
    analytics: container.analytics,
    recommendations: container.recommendations,
    prompts: container.prompts,
    promptRuns: container.promptRuns,
    comparison: container.comparison,
    reports: container.reports,
    billing: container.billing,
    webhooks: container.webhooks,
    baseUrl: env.API_BASE_URL,
    allowedOrigins: container.allowedOrigins,
    health: { checks: container.healthChecks },
    ...(env.ADMIN_USERNAME === undefined || env.ADMIN_PASSWORD === undefined
      ? {}
      : {
          admin: {
            username: env.ADMIN_USERNAME,
            password: env.ADMIN_PASSWORD,
            dashboard: container.queueDashboard.plugin,
          },
        }),
    onUnexpected: (error) => telemetry.captureException(error),
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down api");
    try {
      await app.close();
      await container.shutdown();
      await telemetry.flush();
      process.exit(0);
    } catch (error) {
      telemetry.captureException(error);
      logger.error({ err: error }, "graceful shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT }, "api listening");
}

main().catch((error: unknown) => {
  telemetry.captureException(error);
  logger.fatal({ err: error }, "api failed to start");
  process.exit(1);
});
