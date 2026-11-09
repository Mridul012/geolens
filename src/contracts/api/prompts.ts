/** Tracked prompt payloads (docs/API.md §3 — Prompt Tracking). */
import { z } from "zod";
import { uuidSchema } from "./common.js";

export const promptTemplateSchema = z.object({
  id: uuidSchema,
  text: z.string(),
  intent: z.string().nullable(),
  source: z.enum(["GENERATED", "USER"]),
  pinned: z.boolean(),
  status: z.enum(["ACTIVE", "ARCHIVED"]),
  position: z.number().int(),
});

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;

export const promptListSchema = z.object({ data: z.array(promptTemplateSchema) });

export const createPromptBodySchema = z.object({
  text: z.string().min(8).max(500),
  intent: z.string().max(40).optional(),
  pinned: z.boolean().optional(),
});

/**
 * `text` is accepted by the schema and then refused by the use case with
 * `403 PROMPT_TEXT_IMMUTABLE`.
 *
 * Stripping it here instead would be worse: the client would get a 200 and believe its
 * edit landed. A caller that sends it deserves to be told why it cannot (docs/API.md §4.1).
 */
export const updatePromptBodySchema = z
  .object({
    pinned: z.boolean(),
    status: z.enum(["ACTIVE", "ARCHIVED"]),
    position: z.number().int().min(0),
    text: z.string(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update.",
  });
