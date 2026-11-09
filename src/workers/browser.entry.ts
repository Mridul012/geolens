// Process entry for the `worker-browser` deployable (Backend §6): crawl + report queues.
// Consumes the queues its pool owns (config/queues.ts). SIGTERM stops claiming, lets
// in-flight work finish or checkpoint, and exits 0 — deploys are non-events.
import { env } from "../config/env.js";
import { createWorkerContainer } from "../composition/workers.js";
import { createProcessTelemetry } from "../composition/telemetry.js";
import { installShutdownHandlers } from "./lifecycle/shutdown.js";

const telemetry = createProcessTelemetry("worker-browser");
const logger = telemetry.logger;

async function main(): Promise<void> {
  const container = createWorkerContainer("browser", logger);
  const health = telemetry.startHealthServer({
    port: env.HEALTH_PORT_WORKER_BROWSER,
    checks: container.healthChecks,
  });
  health.setState("healthy");
  logger.info({ queues: container.runtime.queues }, "worker-browser started");

  installShutdownHandlers({
    logger,
    steps: [
      { name: "health", run: async () => { health.setState("draining"); await health.close(); } },
      { name: "queues", run: () => container.shutdown() },
      { name: "telemetry", run: () => telemetry.flush() },
    ],
  });
}

main().catch((error: unknown) => {
  telemetry.captureException(error);
  logger.fatal({ err: error }, "worker-browser failed to start");
  process.exit(1);
});
