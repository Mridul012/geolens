/**
 * Executive summary output (AI-Pipeline §3.6).
 *
 * The only model output a customer reads verbatim, so its bounds are the PRD's
 * readability commitment made enforceable: 800 characters, and items short enough to
 * render as a list rather than a wall.
 */
import { z } from "zod";

const truncated = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value),
    z.string().min(1).max(max),
  );

export const execSummaryOutputSchema = z.object({
  summary: truncated(800),
  strengths: z.array(truncated(120)).min(2).max(4),
  weaknesses: z.array(truncated(120)).min(2).max(4),
});

export type ExecSummaryOutput = z.infer<typeof execSummaryOutputSchema>;
