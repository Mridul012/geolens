/** Billing payloads (docs/API.md §3 — Billing). */
import { z } from "zod";

export const checkoutUrlSchema = z.object({ url: z.string().url() });
export type CheckoutUrl = z.infer<typeof checkoutUrlSchema>;
