// Workers are not HTTP services, but they must be observable the same way the API is
// (M1: "/health returns 200 for api and both workers"). A bare node http listener keeps
// the worker image free of a web framework.
import { createServer, type Server } from "node:http";
import type { Logger } from "./logger.js";

export type HealthState = "starting" | "healthy" | "draining";

export interface HealthServerHandle {
  readonly setState: (state: HealthState) => void;
  readonly close: () => Promise<void>;
}

export interface HealthServerOptions {
  readonly port: number;
  readonly processName: string;
  readonly logger: Logger;
  /** Readiness probes owned by the caller — e.g. a Redis ping. */
  readonly checks?: ReadonlyArray<{ name: string; check: () => Promise<boolean> }>;
}

export function startHealthServer(options: HealthServerOptions): HealthServerHandle {
  let state: HealthState = "starting";

  const server: Server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    void (async () => {
      const results = await Promise.all(
        (options.checks ?? []).map(async (probe) => {
          try {
            return { name: probe.name, ok: await probe.check() };
          } catch {
            return { name: probe.name, ok: false };
          }
        }),
      );
      const dependenciesOk = results.every((r) => r.ok);
      const ok = state === "healthy" && dependenciesOk;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: ok ? "ok" : "unhealthy",
          process: options.processName,
          state,
          checks: results,
        }),
      );
    })();
  });

  server.listen(options.port, () => {
    options.logger.info({ port: options.port }, "health server listening");
  });

  return {
    setState: (next: HealthState) => {
      state = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
