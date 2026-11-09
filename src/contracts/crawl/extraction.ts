/**
 * What a crawled page yields (PRD FR-3.3).
 *
 * Stored in `page_snapshots.extracted` as JSONB — an evolving artifact, per the schema
 * doc's JSONB policy — while anything queried, charted or aggregated (word count,
 * structured-data presence, link counts) is promoted to a real column alongside it.
 */
import { z } from "zod";

export const headingSchema = z.object({
  level: z.number().int().min(1).max(6),
  text: z.string(),
  /** Ancestor chain, e.g. "Pricing > Enterprise" — drives heading-aware chunking (M10). */
  path: z.string(),
});

export type Heading = z.infer<typeof headingSchema>;

export const extractedLinkSchema = z.object({
  href: z.string(),
  text: z.string(),
  rel: z.string().nullable(),
  internal: z.boolean(),
  nofollow: z.boolean(),
});

export type ExtractedLink = z.infer<typeof extractedLinkSchema>;

export const documentSectionSchema = z.object({
  /** Ancestor chain of the heading this text sits under; null above the first heading. */
  headingPath: z.string().nullable(),
  text: z.string(),
});

export type DocumentSection = z.infer<typeof documentSectionSchema>;

export const extractedPageSchema = z.object({
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonical: z.string().nullable(),
  lang: z.string().nullable(),
  robotsMeta: z.string().nullable(),
  headings: z.array(headingSchema),
  /** Boilerplate-stripped main content. */
  mainText: z.string(),
  /**
   * The same content, split at its headings — what heading-aware chunking consumes (M10).
   *
   * Defaulted rather than required so snapshots written before M10 still parse: those
   * pages fall back to chunking `mainText` as one unheaded section, which is exactly what
   * a page with no headings gets anyway.
   */
  sections: z.array(documentSectionSchema).default([]),
  wordCount: z.number().int().min(0),
  publishedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** Raw JSON-LD blocks; `@type` values are surfaced separately for rule predicates. */
  structuredData: z.array(z.record(z.unknown())),
  structuredDataTypes: z.array(z.string()),
  hasStructuredData: z.boolean(),
  links: z.array(extractedLinkSchema),
  internalLinkCount: z.number().int().min(0),
  externalLinkCount: z.number().int().min(0),
  images: z.object({
    total: z.number().int().min(0),
    withAlt: z.number().int().min(0),
    /** 0–1; null when the page has no images at all. */
    altCoverage: z.number().min(0).max(1).nullable(),
  }),
  openGraph: z.record(z.string()),
  /** Signals the trust component reads (AI-Pipeline §3.5). */
  signals: z.object({
    hasAuthor: z.boolean(),
    authorName: z.string().nullable(),
    outboundCitationCount: z.number().int().min(0),
  }),
});

export type ExtractedPage = z.infer<typeof extractedPageSchema>;
