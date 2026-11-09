/** Project, site and competitor payloads (docs/API.md §3 — Projects/Competitors). */
import { z } from "zod";
import { isoDateTime, uuidSchema } from "./common.js";
import { crawlSchema } from "./crawls.js";
import { scoreSchema } from "./scores.js";

export const siteRoleSchema = z.enum(["OWN", "COMPETITOR"]);

export const siteSchema = z.object({
  id: uuidSchema,
  url: z.string().url(),
  domain: z.string(),
  role: siteRoleSchema,
  name: z.string().nullable(),
});

export type Site = z.infer<typeof siteSchema>;

export const projectStatusSchema = z.enum(["ACTIVE", "ARCHIVED"]);

export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: projectStatusSchema,
  timezone: z.string(),
  createdAt: isoDateTime,
  sites: z.array(siteSchema),
});

export type Project = z.infer<typeof projectSchema>;

export const projectDetailSchema = projectSchema.extend({
  latestCrawl: crawlSchema.nullable(),
  latestScore: scoreSchema.nullable(),
});

export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const createProjectBodySchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2_000),
  competitorUrl: z.string().min(1).max(2_000).optional(),
  timezone: z.string().min(1).max(64).default("UTC"),
});

export const updateProjectBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    timezone: z.string().min(1).max(64),
    status: projectStatusSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update.",
  });

export const addCompetitorBodySchema = z.object({
  url: z.string().min(1).max(2_000),
  name: z.string().min(1).max(120).optional(),
});

export const deleteProjectResponseSchema = z.object({
  status: z.literal("PURGE_SCHEDULED"),
});

export const competitorListSchema = z.object({ data: z.array(siteSchema) });
