/** Auth + identity payloads (docs/API.md §3: SessionInfo, Me). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";

export const signUpBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(10),
  name: z.string().min(1).max(120),
});

export const signInBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const socialSignInBodySchema = z.object({
  provider: z.literal("google"),
  callbackURL: z.string().url().optional(),
});

export const sessionInfoSchema = z.object({
  user: z.object({
    id: uuidSchema,
    email: z.string().email(),
    name: z.string().nullable(),
  }),
  session: z.object({ expiresAt: isoDateTime }),
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

const usageCounterSchema = z.object({ used: z.number().int(), limit: z.number().int() });

export const meSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  name: z.string().nullable(),
  plan: z.enum(["FREE", "PRO"]),
  usage: z.object({
    projects: usageCounterSchema,
    activePrompts: usageCounterSchema,
    onDemandRunsThisWeek: usageCounterSchema,
  }),
});

export type Me = z.infer<typeof meSchema>;
