// BullMQ connection factory. Queues, workers and QueueEvents each hold their own Redis
// connection: BullMQ's blocking reads must never queue behind another subsystem's command.
import type { RedisClient } from "../redis/redis.js";
import { createRedisClient } from "../redis/redis.js";

export function createQueueConnection(): RedisClient {
  return createRedisClient({ forQueue: true });
}
