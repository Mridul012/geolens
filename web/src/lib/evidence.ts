/**
 * Turning raw API evidence into what the Eye Exam dashboard and the page lens show
 * (docs/Frontend-Design.md §3). Plain module — no "use client" — so Server Components can
 * import its values too.
 */
import type { PromptResult } from "@contracts/api/prompt-runs";

export interface LensPage {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly qualityScore: number | null;
  readonly wordCount: number | null;
  /** An AI answer in the latest prompt run cited this exact page. */
  readonly cited: boolean;
  readonly sections: ReadonlyArray<{ heading: string | null; text: string }>;
}

export interface SampleAnswer {
  readonly engine: string;
  readonly text: string;
  readonly brandMentioned: boolean;
  readonly brandCited: boolean;
}

/** example.com, https://www.example.com/ and example.com/?ref=x compare as one host+path. */
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "");
}

export function citedUrls(results: readonly PromptResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.citations ?? []).map(normalizeUrl))];
}

/** The most telling single answer: one that cites the brand, else mentions it, else any. */
export function pickSampleAnswer(results: readonly PromptResult[]): SampleAnswer | null {
  const withText = results.filter((result) => result.answerText);
  const best =
    withText.find((result) => result.brandCited) ??
    withText.find((result) => result.brandMentioned) ??
    withText[0];
  if (!best?.answerText) return null;
  return {
    engine: best.engine,
    text: best.answerText,
    brandMentioned: best.brandMentioned,
    brandCited: best.brandCited,
  };
}

/** `extracted.sections` is stored loosely (z.record(z.unknown())), so read it defensively. */
export function readSections(extracted: Record<string, unknown>): LensPage["sections"] {
  const raw = Array.isArray(extracted.sections) ? extracted.sections : [];
  return raw
    .map((section) => {
      const record = (section ?? {}) as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      const path = record.headingPath;
      const heading =
        Array.isArray(path) && path.length > 0
          ? String(path[path.length - 1])
          : typeof path === "string"
            ? path
            : null;
      return { heading, text };
    })
    .filter((section) => section.text.length > 0);
}

/**
 * Visibility as focus, per page: a page an AI answer cited is sharp; otherwise it blurs as
 * its content-quality score drops; a page never scored blurs most — never mistaken for 0.
 */
export function pageBlurPx(page: Pick<LensPage, "cited" | "qualityScore">): number {
  if (page.cited) return 0;
  if (page.qualityScore === null) return 6;
  return ((100 - Math.max(0, Math.min(100, page.qualityScore))) / 100) * 5;
}
