// Composition root for process-level infrastructure. Entries (http/server.ts,
// workers/*.entry.ts) are edges: they may not construct infrastructure themselves
// (Engineering-Rules §2.2), so the wiring lives here and they receive the result.
import { createLogger, type Logger } from "../infrastructure/telemetry/logger.js";
import {
  captureException,
  flushSentry,
  initSentry,
} from "../infrastructure/telemetry/sentry.js";
import {
  startHealthServer,
  type HealthServerHandle,
} from "../infrastructure/telemetry/health-server.js";
import { env } from "../config/env.js";

export interface ProcessTelemetry {
  readonly logger: Logger;
  readonly captureException: (error: unknown, context?: Record<string, unknown>) => void;
  readonly flush: () => Promise<void>;
  /** Starts the worker health listener; the api process serves /health from Fastify. */
  readonly startHealthServer: (options: {
    port: number;
    checks?: ReadonlyArray<{ name: string; check: () => Promise<boolean> }>;
  }) => HealthServerHandle;
}

export function createProcessTelemetry(processName: string): ProcessTelemetry {
  const logger = createLogger({ process: processName, env: env.NODE_ENV });
  initSentry(processName);
  return {
    logger,
    captureException,
    flush: flushSentry,
    startHealthServer: (options) =>
      startHealthServer({
        port: options.port,
        processName,
        logger,
        ...(options.checks ? { checks: options.checks } : {}),
      }),
  };
}

export type { Logger, HealthServerHandle };
