/**
 * Taxonomy generation output (AI-Pipeline §3.1).
 *
 * Bounds are enforced, not hoped for: 12–20 topics is a **fixed** contract other components
 * depend on, and every string is clamped to a length the UI can render. Model output is
 * untrusted input (§6) — a page that tells the model to emit 500 topics gets a validation
 * failure, not a broken product.
 */
import { z } from "zod";

export const buyerIntentSchema = z.enum(["awareness", "consideration", "decision"]);
export type BuyerIntent = z.infer<typeof buyerIntentSchema>;

export const taxonomyTopicSchema = z.object({
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(200),
  buyerIntent: buyerIntentSchema,
});

export const taxonomyOutputSchema = z
  .object({
    niche: z.string().min(1).max(200),
    topics: z.array(taxonomyTopicSchema).min(12).max(20),
  })
  .refine(
    (output) => {
      // Case-insensitive uniqueness mirrors the database's own partial unique index, so a
      // duplicate is rejected here rather than exploding on insert.
      const labels = output.topics.map((topic) => topic.label.trim().toLowerCase());
      return new Set(labels).size === labels.length;
    },
    { message: "Topic labels must be unique, case-insensitively." },
  )
  .refine(
    (output) =>
      !output.topics.some(
        (topic) => topic.label.trim().toLowerCase() === output.niche.trim().toLowerCase(),
      ),
    { message: "A topic may not simply restate the niche." },
  );

export type TaxonomyOutput = z.infer<typeof taxonomyOutputSchema>;
