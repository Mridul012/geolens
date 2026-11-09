/**
 * Mention and citation detection (AI-Pipeline §4.2, §4.3) — pure, and deterministic first.
 *
 * The design decision worth defending: **LLM judging is the exception, not the mechanism.**
 * A word-boundary match against a known variant set is exact, free, reproducible and
 * auditable; a model asked "was this brand mentioned?" is none of those. On a typical run
 * this file makes the entire determination and the judge is never called, which is also
 * what keeps a run inside its $0.30 budget.
 *
 * The judge exists for the three cases where a match genuinely is ambiguous — a brand named
 * after an English word, a very short name, or a name that only appeared inside a longer
 * token. Those triggers are fixed, not tuned.
 */
import { isCommonWord, normalizeForMatching } from "./variants.js";

export type MentionPosition = "early" | "mid" | "late";

export interface MentionMatch {
  readonly matched: boolean;
  /** The variant that matched, normalized. */
  readonly variant: string | null;
  /** Where in the answer it first appeared, as a percentile bucket. */
  readonly position: MentionPosition | null;
  /** Character offset of the first match, for evidence. */
  readonly offset: number | null;
  /** True when the match needs a judgement call before it can be trusted. */
  readonly ambiguous: boolean;
  readonly ambiguityReason: AmbiguityReason | null;
}

export type AmbiguityReason = "common_word" | "short_variant" | "substring_only";

/** Below this length a match is too easy to hit by accident to trust on its own. */
const MIN_UNAMBIGUOUS_VARIANT = 4;

/** Percentile boundaries for the position bucket (AI-Pipeline §4.2). */
const EARLY_MAX = 33;
const MID_MAX = 66;

export function positionBucket(offset: number, length: number): MentionPosition {
  if (length <= 0) return "early";
  const percentile = (offset / length) * 100;
  if (percentile <= EARLY_MAX) return "early";
  return percentile <= MID_MAX ? "mid" : "late";
}

/** A word-boundary search that works on already-normalized text. */
function findWholeWord(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    const before = index === 0 ? " " : haystack[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex >= haystack.length ? " " : haystack[afterIndex];
    // Normalization has already reduced every separator to a single space, so a boundary
    // is simply "not a letter or digit".
    const boundedBefore = before === undefined || !/[\p{L}\p{N}]/u.test(before);
    const boundedAfter = after === undefined || !/[\p{L}\p{N}]/u.test(after);
    if (boundedBefore && boundedAfter) return index;
    from = index + 1;
  }
}

/**
 * Whether an answer mentions the brand.
 *
 * Variants arrive longest-first, so the most specific spelling claims the match and a
 * two-word brand is not reported as its own one-word fragment.
 */
export function detectMention(
  answerText: string,
  variants: readonly string[],
): MentionMatch {
  const haystack = normalizeForMatching(answerText);
  const absent: MentionMatch = {
    matched: false,
    variant: null,
    position: null,
    offset: null,
    ambiguous: false,
    ambiguityReason: null,
  };
  if (haystack.length === 0 || variants.length === 0) return absent;

  for (const variant of variants) {
    const offset = findWholeWord(haystack, variant);
    if (offset === -1) continue;

    const reason: AmbiguityReason | null = isCommonWord(variant)
      ? "common_word"
      : variant.length < MIN_UNAMBIGUOUS_VARIANT
        ? "short_variant"
        : null;

    return {
      matched: true,
      variant,
      position: positionBucket(offset, haystack.length),
      offset,
      ambiguous: reason !== null,
      ambiguityReason: reason,
    };
  }

  // Nothing matched on a word boundary. A variant buried inside a longer token is not a
  // mention on its own — but it is the third documented trigger, because "geolenshq" in an
  // answer probably does mean us.
  for (const variant of variants) {
    if (variant.length < MIN_UNAMBIGUOUS_VARIANT) continue;
    const offset = haystack.indexOf(variant);
    if (offset === -1) continue;
    return {
      matched: true,
      variant,
      position: positionBucket(offset, haystack.length),
      offset,
      ambiguous: true,
      ambiguityReason: "substring_only",
    };
  }

  return absent;
}

/** A URL an engine offered as a source, already resolved to its registrable domain. */
export interface ResolvedCitation {
  readonly url: string;
  /** eTLD+1, or null when the URL could not be resolved to one. */
  readonly registrableDomain: string | null;
}

export interface CitationMatch {
  readonly cited: boolean;
  /** The citations that resolved to the brand's own registrable domain. */
  readonly matchedUrls: readonly string[];
}

/**
 * Whether any citation points at the brand's own site.
 *
 * Matched on the **registrable domain**, never on the host: `blog.geolens.com` and
 * `docs.geolens.com` are both this business citing itself, and a naive suffix check would
 * also match `notgeolens.com`, which is somebody else entirely.
 */
export function detectCitation(
  citations: readonly ResolvedCitation[],
  ownRegistrableDomain: string,
): CitationMatch {
  const own = ownRegistrableDomain.toLowerCase();
  const matched = citations.filter(
    (citation) => citation.registrableDomain !== null && citation.registrableDomain.toLowerCase() === own,
  );
  return { cited: matched.length > 0, matchedUrls: matched.map((citation) => citation.url) };
}

/** Bare URLs and markdown links in an answer, for engines that return no citation list. */
export function extractUrls(answerText: string): readonly string[] {
  const found = new Set<string>();
  // Markdown links first, so the URL is taken without its trailing paren.
  for (const match of answerText.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  for (const match of answerText.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    // Trailing sentence punctuation is not part of the URL.
    found.add(match[0].replace(/[.,;:!?]+$/, ""));
  }
  return [...found];
}
