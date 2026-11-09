/**
 * Heading-aware chunking (docs/Architecture.md Stage 3).
 *
 * This mirrors how a RAG system ingests a page, because that is the thing being measured:
 * if our chunks are worse than a real retriever's, the retrievability score is measuring
 * our chunker rather than the site. Two properties matter and both are enforced here —
 * a chunk stays inside one heading section unless the sections are too small to stand
 * alone, and every chunk carries the heading path it came from, so a retrieved fragment
 * can say where it lives.
 *
 * Pure and deterministic: same input, same chunks, forever. The same page re-crawled with
 * unchanged content must produce byte-identical chunks or change detection is a lie.
 */
import { estimateTokens, normalizeWhitespace } from "./text.js";

/** What the extractor hands us: the page's prose, split at its headings. */
export interface DocumentSection {
  /** "Pricing > Enterprise", or null for text that sits above the first heading. */
  readonly headingPath: string | null;
  readonly text: string;
}

export interface DraftChunk {
  readonly ordinal: number;
  readonly headingPath: string | null;
  readonly content: string;
  readonly tokenCount: number;
}

/**
 * Chunk sizing, v1.
 *
 * ~350 tokens is the size most production RAG stacks converge on: large enough to carry a
 * complete thought, small enough that a single answer-bearing paragraph is not diluted by
 * four unrelated ones. The hard ceiling leaves headroom under every embedding model's
 * input limit, and the overlap keeps a claim that straddles a boundary retrievable from
 * either side.
 */
export const CHUNK_TARGET_TOKENS = 350;
export const CHUNK_MAX_TOKENS = 512;
export const CHUNK_MIN_TOKENS = 40;
export const CHUNK_OVERLAP_TOKENS = 40;

export interface ChunkOptions {
  readonly targetTokens?: number;
  readonly maxTokens?: number;
  readonly minTokens?: number;
  readonly overlapTokens?: number;
}

interface Buffer {
  headingPath: string | null;
  content: string;
  tokens: number;
}

/**
 * The deepest heading path both arguments sit under.
 *
 * When two small sections merge, claiming either one's own path would be a small lie about
 * where the text came from; their shared ancestor is true of both.
 */
function commonHeadingPath(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  if (a === b) return a;
  const left = a.split(" > ");
  const right = b.split(" > ");
  const shared: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) break;
    shared.push(left[index] as string);
  }
  return shared.length === 0 ? null : shared.join(" > ");
}

/**
 * Sentence boundaries, approximately.
 *
 * A full tokenizer would still be wrong on "Inc." and "e.g.", and the cost of being wrong
 * here is one slightly ragged chunk edge — so this splits on terminal punctuation followed
 * by whitespace and stops there. Anything that survives as an over-long "sentence" is
 * hard-split on words by the caller.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Splits a run of words into pieces of at most `maxTokens`, for prose with no sentences. */
function splitWords(text: string, maxTokens: number): string[] {
  const words = text.split(" ");
  const pieces: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current.join(" ")} ${word}`;
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      pieces.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) pieces.push(current.join(" "));
  return pieces;
}

/** The tail of a piece, up to `overlapTokens`, to seed the next piece with. */
function overlapTail(sentences: readonly string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0) return [];
  const tail: string[] = [];
  let tokens = 0;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index] as string;
    const cost = estimateTokens(sentence);
    if (tokens + cost > overlapTokens) break;
    tail.unshift(sentence);
    tokens += cost;
  }
  return tail;
}

/** Splits one over-long section into overlapping pieces at sentence boundaries. */
function splitSection(text: string, target: number, max: number, overlap: number): string[] {
  const sentences = splitSentences(text).flatMap((sentence) =>
    estimateTokens(sentence) > max ? splitWords(sentence, max) : [sentence],
  );

  const pieces: string[] = [];
  let current: string[] = [];
  let tokens = 0;

  for (const sentence of sentences) {
    const cost = estimateTokens(sentence);
    if (current.length > 0 && tokens + cost > target) {
      pieces.push(current.join(" "));
      current = overlapTail(current, overlap);
      tokens = current.reduce((sum, part) => sum + estimateTokens(part), 0);
    }
    current.push(sentence);
    tokens += cost;
  }
  if (current.length > 0) pieces.push(current.join(" "));
  return pieces;
}

/**
 * Merges undersized chunks into a neighbour where that fits.
 *
 * Without this, a page of short headed stanzas becomes a page of five-word chunks, each
 * one too context-free to retrieve and each one costing an embedding.
 */
function mergeUndersized(chunks: readonly Buffer[], min: number, max: number): Buffer[] {
  const merged: Buffer[] = [];
  for (const chunk of chunks) {
    const previous = merged.at(-1);
    if (
      chunk.tokens < min &&
      previous !== undefined &&
      previous.tokens + chunk.tokens <= max
    ) {
      previous.content = `${previous.content}\n\n${chunk.content}`;
      previous.tokens = estimateTokens(previous.content);
      previous.headingPath = commonHeadingPath(previous.headingPath, chunk.headingPath);
      continue;
    }
    merged.push({ ...chunk });
  }
  return merged;
}

/**
 * Turns a page's sections into chunks.
 *
 * Sections arrive in document order; the output is in the same order, numbered from zero.
 * A page with no sections at all still produces chunks from `fallbackText`, because a page
 * without a single heading is common and is not a reason to index nothing.
 */
export function chunkDocument(
  input: { readonly sections: readonly DocumentSection[]; readonly fallbackText?: string },
  options: ChunkOptions = {},
): readonly DraftChunk[] {
  const target = options.targetTokens ?? CHUNK_TARGET_TOKENS;
  const max = options.maxTokens ?? CHUNK_MAX_TOKENS;
  const min = options.minTokens ?? CHUNK_MIN_TOKENS;
  const overlap = options.overlapTokens ?? CHUNK_OVERLAP_TOKENS;

  const sections: DocumentSection[] = input.sections
    .map((section) => ({ headingPath: section.headingPath, text: normalizeWhitespace(section.text) }))
    .filter((section) => section.text.length > 0);

  if (sections.length === 0) {
    const fallback = normalizeWhitespace(input.fallbackText ?? "");
    if (fallback.length === 0) return [];
    sections.push({ headingPath: null, text: fallback });
  }

  const packed: Buffer[] = [];
  let buffer: Buffer | null = null;

  const flush = (): void => {
    if (buffer !== null) packed.push(buffer);
    buffer = null;
  };

  for (const section of sections) {
    const tokens = estimateTokens(section.text);

    if (tokens > max) {
      // A long section is the page's own unit of meaning: never glue a neighbour to it.
      flush();
      for (const piece of splitSection(section.text, target, max, overlap)) {
        packed.push({
          headingPath: section.headingPath,
          content: piece,
          tokens: estimateTokens(piece),
        });
      }
      continue;
    }

    if (buffer === null) {
      buffer = { headingPath: section.headingPath, content: section.text, tokens };
      continue;
    }

    // Only small neighbours combine, and only up to the target — never the hard ceiling,
    // so a merged chunk still has room to be readable.
    if (buffer.tokens + tokens <= target) {
      buffer.content = `${buffer.content}\n\n${section.text}`;
      buffer.tokens = estimateTokens(buffer.content);
      buffer.headingPath = commonHeadingPath(buffer.headingPath, section.headingPath);
      continue;
    }

    flush();
    buffer = { headingPath: section.headingPath, content: section.text, tokens };
  }
  flush();

  return mergeUndersized(packed, min, max).map((chunk, ordinal) => ({
    ordinal,
    headingPath: chunk.headingPath,
    content: chunk.content,
    tokenCount: chunk.tokens,
  }));
}

/**
 * The text actually sent to the embedding model.
 *
 * The heading path is prepended rather than stored inside `content`: retrieval quality
 * improves markedly when "Pricing > Enterprise" is part of the embedded string, but a
 * citation should quote the page's prose, not our breadcrumb.
 */
export function embeddableText(chunk: Pick<DraftChunk, "headingPath" | "content">): string {
  return chunk.headingPath === null ? chunk.content : `${chunk.headingPath}\n${chunk.content}`;
}
