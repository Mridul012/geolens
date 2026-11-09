/**
 * LLM tracing (docs/Backend.md §7.5 — Langfuse, chosen for self-hosting and prompt
 * versioning).
 *
 * Tracing is observability, never a dependency of correctness: an unconfigured or
 * unreachable tracer must not affect a single answer. The no-op implementation is the
 * default, and every method swallows its own failures.
 */
import type { Logger } from "../../telemetry/logger.js";

export interface TraceStart {
  readonly name: string;
  readonly purpose: string;
  readonly model: string;
  readonly provider: string;
  readonly projectId?: string;
  readonly requestId?: string;
}

export interface TraceHandle {
  succeed(result: { repaired: boolean; costUsdMicros: bigint }): void;
  fail(reason: string): void;
}

export interface AiTracer {
  startTrace(start: TraceStart): TraceHandle;
  warn(message: string): void;
  flush(): Promise<void>;
}

const NOOP_HANDLE: TraceHandle = { succeed: () => undefined, fail: () => undefined };

/** Used when Langfuse is unconfigured — the normal case in development and CI. */
export const noopTracer: AiTracer = {
  startTrace: () => NOOP_HANDLE,
  warn: () => undefined,
  flush: async () => undefined,
};

/**
 * Logs every call at debug level. Not a substitute for Langfuse, but it makes the local
 * pipeline legible without an account, and it is what `AI_PROVIDER_MODE=fake` runs with.
 */
export function createLoggingTracer(logger: Logger): AiTracer {
  return {
    startTrace: (start) => {
      const startedAt = Date.now();
      return {
        succeed: (result) => {
          logger.debug(
            {
              ...start,
              repaired: result.repaired,
              costUsdMicros: result.costUsdMicros.toString(),
              latencyMs: Date.now() - startedAt,
            },
            "ai call",
          );
        },
        fail: (reason) => {
          logger.warn({ ...start, reason, latencyMs: Date.now() - startedAt }, "ai call failed");
        },
      };
    },
    warn: (message) => logger.warn({ scope: "ai" }, message),
    flush: async () => undefined,
  };
}
