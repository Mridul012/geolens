/**
 * Graceful shutdown (Engineering-Rules §7): SIGTERM stops claiming, drains, exits 0.
 * A stuck drain must still let the process go, or a deploy wedges.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdownHandlers } from "../../../src/workers/lifecycle/shutdown.js";

const silentLogger = { info: () => undefined, error: () => undefined };

afterEach(() => {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  vi.useRealTimers();
});

describe("installShutdownHandlers", () => {
  it("runs every step in order and exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();

    const shutdown = installShutdownHandlers({
      logger: silentLogger,
      exit,
      steps: [
        { name: "health", run: async () => void order.push("health") },
        { name: "queues", run: async () => void order.push("queues") },
        { name: "telemetry", run: async () => void order.push("telemetry") },
      ],
    });

    await shutdown();

    expect(order).toEqual(["health", "queues", "telemetry"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second signal does not re-drain", async () => {
    let runs = 0;
    const exit = vi.fn();
    const shutdown = installShutdownHandlers({
      logger: silentLogger,
      exit,
      steps: [{ name: "queues", run: async () => void (runs += 1) }],
    });

    await shutdown();
    await shutdown();

    expect(runs).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when a drain step throws, rather than hanging", async () => {
    const exit = vi.fn();
    const shutdown = installShutdownHandlers({
      logger: silentLogger,
      exit,
      steps: [
        {
          name: "queues",
          run: async () => {
            throw new Error("redis gone");
          },
        },
      ],
    });

    await shutdown();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("gives up after the grace period so a stuck drain cannot wedge a deploy", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();

    installShutdownHandlers({
      logger: silentLogger,
      exit,
      graceMs: 1_000,
      steps: [{ name: "stuck", run: () => new Promise<void>(() => undefined) }],
    });

    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_100);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("responds to SIGTERM and SIGINT alike", async () => {
    const exit = vi.fn();
    let drained = false;
    installShutdownHandlers({
      logger: silentLogger,
      exit,
      steps: [{ name: "queues", run: async () => void (drained = true) }],
    });

    process.emit("SIGINT");
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(exit).toHaveBeenCalledWith(0);
  });
});
