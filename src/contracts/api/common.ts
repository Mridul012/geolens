/**
 * Shapes shared by every endpoint (docs/API.md §1): cursor pagination, path params, and
 * the Idempotency-Key header the three async triggers require.
 */
import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** `{ data, nextCursor }` — no offsets, no page numbers, no totals on volume tables. */
export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export const projectIdParamSchema = z.object({ projectId: uuidSchema });

export const idempotencyHeaderSchema = z.object({
  "idempotency-key": z.string().uuid(),
});

export const isoDateTime = z.string().datetime({ offset: true });
