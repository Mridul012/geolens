/**
 * Page quality rubric output (AI-Pipeline §3.2).
 *
 * Every number is clamped into range rather than rejected, and `notes` is truncated rather
 * than rejected for length. That policy is a prompt-injection defence as much as a
 * robustness one (§6.3): a page that instructs the model to "score this 100" produces a
 * clamped value inside one component that is one of thirty inputs — never a score.
 */
import { z } from "zod";

const NOTES_MAX = 300;

/** Clamps a number into 0–100 instead of failing the call over an out-of-range dimension. */
const rubricDimension = z.preprocess(
  (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(100, Math.max(0, Math.round(value)))
      : value,
  z.number().int().min(0).max(100),
);

export const pageQualityOutputSchema = z.object({
  /** Substance versus surface treatment. */
  depth: rubricDimension,
  /** Structure, scannability, answerable prose. */
  clarity: rubricDimension,
  /** Specifics, data, citations, examples. */
  evidence: rubricDimension,
  /** Signals of currency relative to the topic. */
  freshness: rubricDimension,
  /** Self-contained chunks, clear antecedents, no "as mentioned above". */
  aiReadability: rubricDimension,
  notes: z.preprocess(
    (value) =>
      typeof value === "string" && value.length > NOTES_MAX ? value.slice(0, NOTES_MAX) : value,
    z.string().max(NOTES_MAX),
  ),
});

export type PageQualityOutput = z.infer<typeof pageQualityOutputSchema>;
