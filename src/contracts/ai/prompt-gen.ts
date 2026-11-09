/**
 * Generated tracked prompts (M14).
 *
 * These become the questions we ask real engines every week, and their text is immutable
 * once created — editing one would silently redefine what its own trend line measures. So
 * the bounds are enforced rather than trimmed: a prompt too long to run, or one that names
 * no real buyer intent, is a validation failure now instead of a corrupted metric later.
 */
import { z } from "zod";

/** Open set by design (docs/Database.md §2.12) — the API stores intent as free text. */
export const PROMPT_INTENTS = ["comparison", "recommendation", "howto"] as const;

export const generatedPromptSchema = z.object({
  text: z.string().min(8).max(500),
  intent: z.enum(PROMPT_INTENTS),
});

export type GeneratedPrompt = z.infer<typeof generatedPromptSchema>;

export const promptSetOutputSchema = z
  .object({
    prompts: z.array(generatedPromptSchema).min(10).max(10),
  })
  .refine(
    (output) => {
      // The database's `unique (project_id, md5(text)) where ACTIVE` would reject these
      // one at a time; catching it here means the whole set fails cleanly rather than
      // half-inserting.
      const texts = output.prompts.map((prompt) => prompt.text.trim().toLowerCase());
      return new Set(texts).size === texts.length;
    },
    { message: "Prompts must be distinct." },
  )
  .refine(
    (output) => new Set(output.prompts.map((prompt) => prompt.intent)).size >= 2,
    { message: "Prompts must span more than one buyer intent." },
  );

export type PromptSetOutput = z.infer<typeof promptSetOutputSchema>;
