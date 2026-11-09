// Error reporting for all three processes (Backend §15 observability stack).
// A missing DSN is a supported configuration (local dev, CI) — not an error.
import * as Sentry from "@sentry/node";
import { env } from "../../config/env.js";

let initialized = false;

export function initSentry(processName: string): boolean {
  if (initialized || env.SENTRY_DSN === undefined) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === "production" ? 0.1 : 0,
    initialScope: { tags: { process: processName } },
  });
  initialized = true;
  return true;
}

export function captureException(error: unknown, context?: Readonly<Record<string, unknown>>): void {
  if (!initialized) return;
  Sentry.captureException(error, context ? { extra: { ...context } } : undefined);
}

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}
