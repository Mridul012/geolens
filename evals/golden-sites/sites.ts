/**
 * The golden corpus (AI-Pipeline §8).
 *
 * Six fixture sites whose scores are recorded in `baseline.json`. The point is not that
 * any particular number is *right* — it is that a change to a prompt, a model tier or a
 * scoring weight cannot move a customer's score without someone noticing and saying why.
 *
 * The sites are described as facts rather than HTML: this eval exercises the scoring
 * engine, not the crawler, and the crawler has its own fixtures served over real sockets.
 * Keeping them declarative means a baseline shift is always traceable to the scoring
 * config, never to a stray change in a `<div>`.
 *
 * §8 lists a sixth "real site snapshot pinned by content hash". That one is deliberately
 * absent: pinning a third party's content into this repository is a licensing and privacy
 * decision, not an engineering one. `stale-blog` stands in its place as the sixth profile,
 * and the gap is called out in the M12 notes rather than papered over.
 */
import type { PageSpec } from "./fixtures.js";

export interface GoldenSite {
  readonly key: string;
  readonly description: string;
  readonly domain: string;
  /** Bot access as the M8 check reports it: 0–100, GPTBot and PerplexityBot double-weighted. */
  readonly botAccessShare: number;
  readonly llmsTxt: { readonly present: boolean; readonly valid: boolean | null };
  readonly sitemapPresent: boolean;
  /** The retrievability component, as M11 would have written it. */
  readonly retrievability: number | null;
  readonly topics: ReadonlyArray<{
    readonly label: string;
    readonly intent: "awareness" | "consideration" | "decision" | null;
    readonly coverage: number;
  }>;
  readonly pages: readonly PageSpec[];
  /** Competitor coverage, for the missing-topic assertion. */
  readonly competitorCoverage?: Readonly<Record<string, number>>;
}

const RICH_TOPICS = [
  { label: "Pricing and plans", intent: "decision" as const, coverage: 82 },
  { label: "Security and compliance", intent: "decision" as const, coverage: 78 },
  { label: "API reference", intent: "consideration" as const, coverage: 74 },
  { label: "Getting started", intent: "awareness" as const, coverage: 66 },
  { label: "Migration guides", intent: "decision" as const, coverage: 12 },
];

/** A well-run page: prose, a canonical, a description, a byline and outbound citations. */
const goodPage = (path: string, quality: number): PageSpec => ({
  path,
  wordCount: 900,
  structuredData: true,
  canonical: true,
  metaDescription: true,
  author: true,
  citations: 4,
  qualityScore: quality,
});

/** A stub: it exists, and that is all that can be said for it. */
const thinPage = (path: string, quality: number): PageSpec => ({
  path,
  wordCount: 120,
  structuredData: false,
  canonical: false,
  metaDescription: false,
  author: false,
  citations: 0,
  qualityScore: quality,
});

export const GOLDEN_SITES: readonly GoldenSite[] = [
  {
    key: "rich-saas",
    description: "A well-run SaaS site: deep content, clean markup, every bot welcome.",
    domain: "rich.example",
    botAccessShare: 100,
    llmsTxt: { present: true, valid: true },
    sitemapPresent: true,
    retrievability: 78,
    topics: RICH_TOPICS,
    competitorCoverage: { "Migration guides": 84 },
    pages: [
      goodPage("/", 84),
      goodPage("/pricing", 86),
      goodPage("/security", 80),
      goodPage("/docs/api", 78),
      goodPage("/blog/getting-started", 72),
      goodPage("/about", 64),
      { ...goodPage("/contact", 58), wordCount: 150 },
      { ...goodPage("/privacy", 55), dated: true },
    ],
  },
  {
    key: "thin-saas",
    description: "The same shape of business with nothing written down.",
    domain: "thin.example",
    botAccessShare: 100,
    llmsTxt: { present: false, valid: null },
    sitemapPresent: true,
    retrievability: 18,
    topics: RICH_TOPICS.map((topic) => ({ ...topic, coverage: Math.round(topic.coverage / 6) })),
    pages: [thinPage("/", 26), thinPage("/pricing", 22), thinPage("/contact", 18)],
  },
  {
    key: "blog-heavy",
    description: "Plenty of articles, no product or decision-stage content.",
    domain: "blog.example",
    botAccessShare: 100,
    llmsTxt: { present: false, valid: null },
    sitemapPresent: true,
    retrievability: 52,
    topics: [
      { label: "Getting started", intent: "awareness", coverage: 88 },
      { label: "Industry trends", intent: "awareness", coverage: 84 },
      { label: "Pricing and plans", intent: "decision", coverage: 8 },
      { label: "Security and compliance", intent: "decision", coverage: 6 },
    ],
    pages: [
      goodPage("/", 70),
      goodPage("/blog/one", 76),
      goodPage("/blog/two", 74),
      goodPage("/blog/three", 72),
      goodPage("/about", 60),
    ],
  },
  {
    key: "robots-blocked",
    description: "Good content nobody can read: every AI crawler blocked in robots.txt.",
    domain: "blocked.example",
    botAccessShare: 0,
    llmsTxt: { present: false, valid: null },
    sitemapPresent: true,
    retrievability: 74,
    topics: RICH_TOPICS,
    pages: [goodPage("/", 82), goodPage("/pricing", 80), goodPage("/security", 78)],
  },
  {
    key: "no-structured-data",
    description: "Strong prose, no schema.org, no canonicals — invisible plumbing.",
    domain: "nomarkup.example",
    botAccessShare: 100,
    llmsTxt: { present: false, valid: null },
    sitemapPresent: false,
    retrievability: 64,
    topics: RICH_TOPICS,
    pages: [
      { ...goodPage("/", 76), structuredData: false, canonical: false },
      { ...goodPage("/pricing", 74), structuredData: false, canonical: false },
      { ...goodPage("/security", 70), structuredData: false, canonical: false },
    ],
  },
  {
    key: "stale-blog",
    description: "Everything present, everything years old and uncited.",
    domain: "stale.example",
    botAccessShare: 100,
    llmsTxt: { present: true, valid: false },
    sitemapPresent: true,
    retrievability: 38,
    topics: RICH_TOPICS.map((topic) => ({ ...topic, coverage: Math.round(topic.coverage / 2) })),
    pages: [
      { ...goodPage("/", 44), citations: 0, author: false },
      { ...goodPage("/blog/old", 40), citations: 0, author: false },
      { ...goodPage("/blog/older", 36), citations: 0, author: false },
    ],
  },
];
