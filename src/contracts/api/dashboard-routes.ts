/** Query and response shapes for the score endpoints (docs/API.md §3). */
import { z } from "zod";
import { scoreSchema } from "./scores.js";

export const scoreListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const scoreListSchema = z.object({
  data: z.array(scoreSchema),
  nextCursor: z.string().nullable(),
});

export const scoreBreakdownSchema = z.object({
  score: scoreSchema.nullable(),
  /** The breakdown drawer: per-component value, weight, effective weight, evidence. */
  components: z.record(z.unknown()).nullable(),
});
