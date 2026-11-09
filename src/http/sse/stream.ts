/**
 * Server-sent events (docs/API.md §1 — SSE).
 *
 * Read-only, resume-safe, and stateless on the server: the stream polls the ProgressStore
 * and emits what it finds. A client that reconnects gets current state immediately rather
 * than missing whatever happened while it was away, which is why progress lives in a Redis
 * hash and not a pub/sub channel.
 *
 * Heartbeats every 15s keep proxies from closing an idle stream.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

export interface SseStreamOptions {
  /** Called on each tick; returning `done` ends the stream after emitting. */
  readonly poll: () => Promise<{ events: readonly SseEvent[]; done: boolean }>;
  readonly intervalMs?: number;
  readonly heartbeatMs?: number;
  /** Hard cap so an abandoned stream cannot hold a connection forever. */
  readonly maxDurationMs?: number;
}

const DEFAULTS = {
  intervalMs: 1_500,
  heartbeatMs: 15_000,
  maxDurationMs: 30 * 60_000,
} as const;

function write(reply: FastifyReply, event: SseEvent): void {
  reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

/**
 * Streams until `poll` reports done, the client disconnects, or the cap is reached.
 *
 * Returns only when the stream is over, so the route handler's lifetime matches the
 * connection's.
 */
export async function streamSse(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SseStreamOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const maxDurationMs = options.maxDurationMs ?? DEFAULTS.maxDurationMs;

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nginx and friends buffer by default, which turns a live stream into one big blob.
    "x-accel-buffering": "no",
  });

  let closed = false;
  const onClose = (): void => {
    closed = true;
  };
  request.raw.on("close", onClose);

  const startedAt = Date.now();
  let lastHeartbeat = startedAt;

  try {
    for (;;) {
      if (closed) return;

      const { events, done } = await options.poll();
      for (const event of events) write(reply, event);

      if (done) return;
      if (Date.now() - startedAt > maxDurationMs) return;

      if (Date.now() - lastHeartbeat >= heartbeatMs) {
        // Comment frame: valid SSE, ignored by EventSource, keeps the socket warm.
        reply.raw.write(": heartbeat\n\n");
        lastHeartbeat = Date.now();
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    request.raw.off("close", onClose);
    if (!closed) reply.raw.end();
  }
}
