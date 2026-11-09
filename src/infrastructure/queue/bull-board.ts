/**
 * Bull Board wiring. Lives in infrastructure because it speaks BullMQ; the HTTP layer only
 * ever sees an opaque Fastify plugin it mounts behind admin auth.
 */
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import type { Queue } from "bullmq";
import type { FastifyPluginCallback } from "fastify";

export interface QueueDashboard {
  readonly basePath: string;
  readonly plugin: FastifyPluginCallback;
}

export function createQueueDashboard(
  queues: readonly Queue[],
  basePath: string,
): QueueDashboard {
  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });
  serverAdapter.setBasePath(basePath);
  return { basePath, plugin: serverAdapter.registerPlugin() as FastifyPluginCallback };
}
