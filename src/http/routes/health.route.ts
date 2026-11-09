// Liveness/readiness for the api process (API Contract §2 — System group, public).
import type { FastifyInstance } from "fastify";

export interface HealthDependencies {
  /** Readiness probes; each must resolve quickly and never throw for a normal outage. */
  readonly checks?: ReadonlyArray<{ name: string; check: () => Promise<boolean> }>;
}

export function registerHealthRoute(app: FastifyInstance, deps: HealthDependencies = {}): void {
  app.get("/health", async (_request, reply) => {
    const results = await Promise.all(
      (deps.checks ?? []).map(async (probe) => {
        try {
          return { name: probe.name, ok: await probe.check() };
        } catch {
          return { name: probe.name, ok: false };
        }
      }),
    );
    const ok = results.every((r) => r.ok);
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "unhealthy",
      process: "api",
      checks: results,
    });
  });
}
