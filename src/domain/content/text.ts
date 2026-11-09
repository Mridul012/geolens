/**
 * Text measurements — pure, and shared by extraction, chunking and the quality rubric.
 *
 * Word counting looks trivial until two callers disagree about it and a page's "thin
 * content" verdict flips between the crawler and the recommendation engine. One
 * definition, one place.
 */

/**
 * Collapses whitespace runs to single spaces.
 *
 * The class covers regular whitespace plus the two characters that break naive counting on
 * real pages: U+00A0 non-breaking space (rife in CMS output) and U+200B zero-width space
 * (injected by some editors). Escaped rather than literal so they stay visible in a diff.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/[\s\u00a0\u200b]+/g, " ").trim();
}

/**
 * Words are whitespace-delimited runs containing at least one letter or digit, so
 * punctuation, bullets and stray symbols do not inflate the count.
 */
export function countWords(text: string): number {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) return 0;
  let count = 0;
  for (const token of normalized.split(" ")) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}

/**
 * A crude token estimate for budgeting prompt input.
 *
 * Deliberately not a real tokenizer: we need a bound to slice content by, not an exact
 * count, and shipping a per-provider BPE table to get a number we immediately round would
 * be false precision. ~4 characters per token holds well enough for English prose.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(normalizeWhitespace(text).length / 4);
}

/** Truncates on a word boundary so a slice never ends mid-word. */
export function truncateWords(text: string, maxWords: number): string {
  const normalized = normalizeWhitespace(text);
  if (maxWords <= 0) return "";
  const words = normalized.split(" ");
  return words.length <= maxWords ? normalized : words.slice(0, maxWords).join(" ");
}

/** Truncates to an estimated token budget, on a word boundary. */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const normalized = normalizeWhitespace(text);
  if (estimateTokens(normalized) <= maxTokens) return normalized;
  // ~4 chars/token, and a word averages ~5 chars with its separator.
  return truncateWords(normalized, Math.max(1, Math.floor((maxTokens * 4) / 5)));
}

/**
 * Builds the "A > B > C" ancestor path for a heading at `level`, given the open headings
 * above it. Chunking uses this so a retrieved fragment carries where it came from.
 */
export function headingPath(ancestors: ReadonlyArray<{ level: number; text: string }>, level: number, text: string): string {
  const chain = ancestors.filter((heading) => heading.level < level).map((heading) => heading.text);
  return [...chain, text].join(" > ");
}
