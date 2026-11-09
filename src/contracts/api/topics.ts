/** Topic payloads (docs/API.md §3 — Analysis group). */
import { z } from "zod";
import { uuidSchema } from "./common.js";

export const topicSchema = z.object({
  id: uuidSchema,
  label: z.string(),
  description: z.string().nullable(),
  source: z.enum(["GENERATED", "USER"]),
  /** Buyer stage; null for user-added topics (ADR 0004). Read-only. */
  buyerIntent: z.enum(["awareness", "consideration", "decision"]).nullable(),
  status: z.enum(["ACTIVE", "ARCHIVED"]),
  position: z.number().int(),
});

export type Topic = z.infer<typeof topicSchema>;

export const topicListSchema = z.object({ data: z.array(topicSchema) });

export const createTopicBodySchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export const updateTopicBodySchema = z
  .object({
    label: z.string().min(1).max(120),
    description: z.string().max(500),
    position: z.number().int().min(0),
    status: z.enum(["ACTIVE", "ARCHIVED"]),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update.",
  });
