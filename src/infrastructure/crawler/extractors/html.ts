/**
 * Per-page extraction (PRD FR-3.3, docs/Architecture.md Stage 1).
 *
 * Lives in infrastructure because it needs an HTML parser; everything it *decides* —
 * word counts, heading paths, what counts as internal — comes from pure domain functions,
 * so the judgement calls stay testable without a DOM.
 *
 * Boilerplate removal matters more here than it looks: chunks cut from nav and footer text
 * poison retrieval, and a page whose "content" is its cookie banner scores as thin when it
 * is not (and vice versa).
 */
import { randomBytes } from "node:crypto";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type {
  DocumentSection,
  ExtractedLink,
  ExtractedPage,
  Heading,
} from "../../../contracts/crawl/extraction.js";
import { countWords, headingPath, normalizeWhitespace } from "../../../domain/content/text.js";
import { normalizePageUrl } from "../../../domain/crawl/url.js";

/** Stripped before any text is read: never content, always noise. */
const NON_CONTENT_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  ".cookie-banner",
  "#cookie-banner",
  ".skip-link",
].join(", ");

/** Tried in order; the first that yields real text wins. */
const MAIN_CONTENT_SELECTORS = [
  "main",
  '[role="main"]',
  "article",
  "#content",
  ".content",
  "#main",
  ".main",
  ".post-body",
  ".entry-content",
];

const MIN_MAIN_WORDS = 40;

/** The chosen container only — a page with two `<main>` elements has one content area. */
function firstTextOf($: CheerioAPI, selector: string): string {
  return normalizeWhitespace($(selector).first().text());
}

/**
 * Picks the element most likely to hold the page's actual content.
 *
 * Semantic containers first; falling back to `body` is correct for the many sites that
 * never adopted them, and the noise selectors have already been removed by then.
 */
function selectMainContainer($: CheerioAPI): string {
  for (const selector of MAIN_CONTENT_SELECTORS) {
    if (countWords(firstTextOf($, selector)) >= MIN_MAIN_WORDS) return selector;
  }
  return "body";
}

/**
 * A sentinel inserted where each heading starts, so the container's text can be sliced
 * back into sections.
 *
 * The alternative — walking the DOM node by node — means importing `domhandler`'s node
 * types, a transitive dependency we have not declared. Marking and splitting uses only
 * cheerio's own API and produces the same partition.
 *
 * The nonce is the important part. Page content is untrusted, and a fixed sentinel is a
 * string a page can simply contain — at which point its own text splits the document and
 * the page indexes to nothing. A fresh random marker per extraction cannot be guessed by
 * the thing being extracted. It never reaches the output, so extraction stays
 * deterministic where it counts: identical HTML still yields identical sections.
 */
function sectionMarker(): { open: string; pattern: RegExp } {
  const nonce = randomBytes(8).toString("hex");
  return {
    open: `@@VRYSE-SECTION-${nonce}:`,
    pattern: new RegExp(`@@VRYSE-SECTION-${nonce}:(\\d+)@@`, "g"),
  };
}

/**
 * Splits the main container's text at its headings (M10 chunking input).
 *
 * Heading paths are computed over the *container's* headings rather than the whole
 * document's: a heading in a stripped sidebar is not an ancestor of the article's prose,
 * and pretending otherwise would put the wrong breadcrumb on a retrieved chunk.
 */
function extractSections($: CheerioAPI, containerSelector: string): DocumentSection[] {
  const container = $(containerSelector).first();
  if (container.length === 0) return [];

  const marker = sectionMarker();
  const clone = container.clone();
  const headings = clone.find("h1, h2, h3, h4, h5, h6");
  const open: Array<{ level: number; text: string }> = [];
  const paths: Array<string | null> = [];

  headings.each((_index, element) => {
    const tag = (element as { tagName?: string }).tagName ?? "h1";
    const level = Number(tag.slice(1));
    const text = normalizeWhitespace($(element).text());
    if (text.length === 0) {
      paths.push(null);
      return;
    }
    while (open.length > 0 && (open.at(-1)?.level ?? 0) >= level) open.pop();
    paths.push(headingPath(open, level, text));
    open.push({ level, text });
  });

  headings.each((index, element) => {
    // The heading's own words live in the path, so they are removed from the body rather
    // than repeated at the top of every chunk.
    $(element).before(`\n${marker.open}${index}@@\n`);
    $(element).text("");
  });

  const parts = clone.text().split(marker.pattern);
  const sections: DocumentSection[] = [];

  const preamble = normalizeWhitespace(parts[0] ?? "");
  if (preamble.length > 0) sections.push({ headingPath: null, text: preamble });

  for (let index = 1; index < parts.length; index += 2) {
    const marker = Number(parts[index]);
    const text = normalizeWhitespace(parts[index + 1] ?? "");
    if (text.length === 0) continue;
    sections.push({ headingPath: paths[marker] ?? null, text });
  }

  return sections;
}

function extractHeadings($: CheerioAPI): Heading[] {
  const headings: Heading[] = [];
  const open: Array<{ level: number; text: string }> = [];

  $("h1, h2, h3, h4, h5, h6").each((_index, element) => {
    const tag = (element as { tagName?: string }).tagName ?? "h1";
    const level = Number(tag.slice(1));
    const text = normalizeWhitespace($(element).text());
    if (text.length === 0) return;

    // Close any open heading at or below this level before recording the ancestry.
    while (open.length > 0 && (open.at(-1)?.level ?? 0) >= level) open.pop();
    headings.push({ level, text, path: headingPath(open, level, text) });
    open.push({ level, text });
  });

  return headings;
}

/** JSON-LD blocks, with malformed ones skipped rather than failing the whole extraction. */
function extractStructuredData($: CheerioAPI): {
  blocks: Array<Record<string, unknown>>;
  types: string[];
} {
  const blocks: Array<Record<string, unknown>> = [];
  const types = new Set<string>();

  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).contents().text().trim();
    if (raw.length === 0) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (typeof candidate !== "object" || candidate === null) continue;
        const record = candidate as Record<string, unknown>;
        blocks.push(record);
        // `@graph` is how most CMSs emit several entities in one block.
        const graph = record["@graph"];
        const entities = Array.isArray(graph) ? graph : [record];
        for (const entity of entities) {
          const type = (entity as Record<string, unknown> | null)?.["@type"];
          if (typeof type === "string") types.add(type);
          if (Array.isArray(type)) {
            for (const item of type) if (typeof item === "string") types.add(item);
          }
        }
      }
    } catch {
      // A page with broken JSON-LD is a finding for the recommendations engine, not a
      // reason to lose every other field on the page.
    }
  });

  return { blocks, types: [...types] };
}

function firstMeta($: CheerioAPI, names: readonly string[]): string | null {
  for (const name of names) {
    const byName = $(`meta[name="${name}"]`).attr("content");
    if (byName !== undefined && byName.trim().length > 0) return byName.trim();
    const byProperty = $(`meta[property="${name}"]`).attr("content");
    if (byProperty !== undefined && byProperty.trim().length > 0) return byProperty.trim();
  }
  return null;
}

/** ISO-8601 if we can parse it, otherwise null — a half-parsed date is worse than none. */
function toIsoDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) return null;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractDates(
  $: CheerioAPI,
  structured: ReadonlyArray<Record<string, unknown>>,
): { publishedAt: string | null; updatedAt: string | null } {
  // Structured data is the most reliable source; meta tags and <time> follow.
  for (const block of structured) {
    const published = toIsoDate(block["datePublished"] as string | undefined);
    const modified = toIsoDate(block["dateModified"] as string | undefined);
    if (published !== null || modified !== null) {
      return { publishedAt: published, updatedAt: modified };
    }
  }

  const metaPublished = toIsoDate(
    firstMeta($, ["article:published_time", "datePublished", "publish-date", "date"]),
  );
  const metaUpdated = toIsoDate(
    firstMeta($, ["article:modified_time", "dateModified", "last-modified", "og:updated_time"]),
  );

  const timePublished =
    metaPublished ?? toIsoDate($("time[datetime]").first().attr("datetime") ?? null);

  return { publishedAt: timePublished, updatedAt: metaUpdated };
}

function extractLinks($: CheerioAPI, pageUrl: string, siteHost: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (href === undefined) return;
    const trimmed = href.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    if (/^(mailto|tel|javascript|data):/i.test(trimmed)) return;

    const resolved = normalizePageUrl(trimmed, pageUrl);
    if (!resolved.ok) return;
    if (seen.has(resolved.value.href)) return;
    seen.add(resolved.value.href);

    const rel = $(element).attr("rel") ?? null;
    links.push({
      href: resolved.value.href,
      text: normalizeWhitespace($(element).text()).slice(0, 200),
      rel,
      // Subdomains count as internal: blog.acme.com is the same business as acme.com.
      internal:
        resolved.value.hostname === siteHost || resolved.value.hostname.endsWith(`.${siteHost}`),
      nofollow: rel !== null && /\bnofollow\b/i.test(rel),
    });
  });

  return links;
}

function extractAuthor($: CheerioAPI, structured: ReadonlyArray<Record<string, unknown>>): {
  hasAuthor: boolean;
  authorName: string | null;
} {
  for (const block of structured) {
    const author = block["author"];
    if (typeof author === "string" && author.trim().length > 0) {
      return { hasAuthor: true, authorName: author.trim() };
    }
    if (typeof author === "object" && author !== null) {
      const name = (author as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.trim().length > 0) {
        return { hasAuthor: true, authorName: name.trim() };
      }
    }
  }

  const metaAuthor = firstMeta($, ["author", "article:author"]);
  if (metaAuthor !== null) return { hasAuthor: true, authorName: metaAuthor };

  const rel = normalizeWhitespace($('[rel="author"]').first().text());
  if (rel.length > 0) return { hasAuthor: true, authorName: rel };

  const byline = normalizeWhitespace($(".author, .byline, [itemprop='author']").first().text());
  return byline.length > 0
    ? { hasAuthor: true, authorName: byline.slice(0, 120) }
    : { hasAuthor: false, authorName: null };
}

function extractOpenGraph($: CheerioAPI): Record<string, string> {
  const graph: Record<string, string> = {};
  $('meta[property^="og:"]').each((_index, element) => {
    const property = $(element).attr("property");
    const content = $(element).attr("content");
    if (property === undefined || content === undefined) return;
    graph[property.slice(3)] = content.trim();
  });
  return graph;
}

export interface ExtractOptions {
  /** The URL this HTML was served from — relative links resolve against it. */
  readonly pageUrl: string;
  /** The site's canonical hostname, for the internal/external split. */
  readonly siteHost: string;
}

/**
 * Extracts every field the pipeline needs from one page of HTML.
 *
 * Total, not partial: a page that fails to yield a title still yields its links, and a
 * page with broken JSON-LD still yields its headings. Extraction never throws on bad
 * markup — the web is full of it, and a crawl that dies on one page is useless.
 */
export function extractPage(html: string, options: ExtractOptions): ExtractedPage {
  const $ = cheerio.load(html);

  // Read anything that lives in <head> or in scripts *before* stripping them.
  const canonicalHref = $('link[rel="canonical"]').attr("href") ?? null;
  const canonical =
    canonicalHref === null
      ? null
      : (() => {
          const resolved = normalizePageUrl(canonicalHref, options.pageUrl);
          return resolved.ok ? resolved.value.href : null;
        })();

  const title =
    normalizeWhitespace($("title").first().text()) ||
    firstMeta($, ["og:title"]) ||
    normalizeWhitespace($("h1").first().text()) ||
    null;

  const metaDescription = firstMeta($, ["description", "og:description"]);
  const robotsMeta = firstMeta($, ["robots"]);
  const lang = $("html").attr("lang")?.trim() ?? null;
  const openGraph = extractOpenGraph($);
  const structured = extractStructuredData($);
  const dates = extractDates($, structured.blocks);
  const author = extractAuthor($, structured.blocks);

  const images = (() => {
    const all = $("img");
    const withAlt = all.filter((_index, element) => {
      const alt = $(element).attr("alt");
      return alt !== undefined && alt.trim().length > 0;
    });
    const total = all.length;
    return {
      total,
      withAlt: withAlt.length,
      altCoverage: total === 0 ? null : withAlt.length / total,
    };
  })();

  const links = extractLinks($, options.pageUrl, options.siteHost);
  const internalLinkCount = links.filter((link) => link.internal).length;
  const externalLinkCount = links.length - internalLinkCount;

  // Now strip the noise and read the content.
  $(NON_CONTENT_SELECTORS).remove();
  const headings = extractHeadings($);
  const container = selectMainContainer($);
  const mainText = firstTextOf($, container);
  const sections = extractSections($, container);

  return {
    title: title === "" ? null : title,
    metaDescription,
    canonical,
    lang: lang === "" ? null : lang,
    robotsMeta,
    headings,
    mainText,
    sections,
    wordCount: countWords(mainText),
    publishedAt: dates.publishedAt,
    updatedAt: dates.updatedAt,
    structuredData: structured.blocks,
    structuredDataTypes: structured.types,
    hasStructuredData: structured.blocks.length > 0,
    links,
    internalLinkCount,
    externalLinkCount,
    images,
    openGraph,
    signals: {
      hasAuthor: author.hasAuthor,
      authorName: author.authorName,
      // Outbound citations to real sources are a trust signal (AI-Pipeline §3.5);
      // nofollow links are advertising, not citation.
      outboundCitationCount: links.filter((link) => !link.internal && !link.nofollow).length,
    },
  };
}
