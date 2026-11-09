// Process entry for the `worker-ai` deployable (Backend §6): index, analyze, aggregate,
// prompt-sim and notify queues — I/O bound, high concurrency.
// Consumes the queues its pool owns (config/queues.ts). SIGTERM stops claiming, lets
// in-flight work finish or checkpoint, and exits 0 — deploys are non-events.
import { env } from "../config/env.js";
import { createWorkerContainer } from "../composition/workers.js";
import { createProcessTelemetry } from "../composition/telemetry.js";
import { installShutdownHandlers } from "./lifecycle/shutdown.js";

const telemetry = createProcessTelemetry("worker-ai");
const logger = telemetry.logger;

async function main(): Promise<void> {
  const container = createWorkerContainer("ai", logger);
  const health = telemetry.startHealthServer({
    port: env.HEALTH_PORT_WORKER_AI,
    checks: container.healthChecks,
  });
  health.setState("healthy");
  logger.info({ queues: container.runtime.queues }, "worker-ai started");

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
  logger.fatal({ err: error }, "worker-ai failed to start");
  process.exit(1);
});
