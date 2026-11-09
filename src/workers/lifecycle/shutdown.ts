/**
 * Worker process lifecycle (Engineering-Rules §7).
 *
 * SIGTERM → stop claiming → drain or checkpoint → exit 0. Deploys and autoscale-downs are
 * then non-events: no job is lost, and no crawl restarts from zero.
 */
import type { JobLogger } from "../../application/ports/job-context.port.js";

export interface Drainable {
  readonly drain: () => Promise<void>;
}

export interface ShutdownOptions {
  readonly logger: Pick<JobLogger, "info" | "error">;
  /** Called in order; each must be safe to call once. */
  readonly steps: ReadonlyArray<{ name: string; run: () => Promise<void> }>;
  /** Hard limit before the process exits regardless — a stuck drain must not wedge a deploy. */
  readonly graceMs?: number;
  readonly exit?: (code: number) => void;
}

export function installShutdownHandlers(options: ShutdownOptions): () => Promise<void> {
  const graceMs = options.graceMs ?? 30_000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger.info({ signal }, "draining worker");

    const timer = setTimeout(() => {
      options.logger.error({ signal, graceMs }, "drain exceeded grace period; exiting anyway");
      exit(1);
    }, graceMs);
    // A pending timer must not itself keep the process alive.
    timer.unref?.();

    try {
      for (const step of options.steps) {
        await step.run();
        options.logger.info({ step: step.name }, "drain step complete");
      }
      clearTimeout(timer);
      exit(0);
    } catch (error) {
      clearTimeout(timer);
      options.logger.error({ err: error }, "drain failed");
      exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return () => shutdown("manual");
}
