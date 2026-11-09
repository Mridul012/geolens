/**
 * Sitemap discovery (PRD FR-3.1: sitemap.xml first, link-following as fallback).
 *
 * A sitemap is the site telling us what it considers a page — far better than guessing
 * from links, and it costs one request. Sitemap *indexes* are followed one level, which
 * covers the overwhelming majority of real sites without turning discovery into its own
 * unbounded crawl.
 *
 * Parsed with regex rather than a DOM: sitemaps are a flat, machine-generated format, the
 * only fields we want are `<loc>` and `<sitemap>`, and pulling in an XML parser to read
 * two tags would be a dependency we cannot justify.
 */
import { normalizePageUrl } from "../../domain/crawl/url.js";
import { parseRobotsTxt, type RobotsTxt } from "../../domain/crawl/robots.js";
import { safeFetch, SsrfBlockedError, type DnsResolver, type Transport } from "./ssrf-guard.js";

const LOC_PATTERN = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const SITEMAP_INDEX_MARKER = /<sitemapindex[\s>]/i;

/** Pulls every `<loc>` value out of a sitemap document. */
export function parseSitemapLocations(xml: string): readonly string[] {
  const locations: string[] = [];
  for (const match of xml.matchAll(LOC_PATTERN)) {
    const value = match[1];
    if (value === undefined) continue;
    locations.push(
      value
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'"),
    );
  }
  return locations;
}

export function isSitemapIndex(xml: string): boolean {
  return SITEMAP_INDEX_MARKER.test(xml);
}

export interface SitemapDiscoveryOptions {
  readonly siteOrigin: string;
  readonly siteHost: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxUrls: number;
  readonly resolver?: DnsResolver;
  /** Test seam, threaded to the guard; defaults to a real pinned socket. */
  readonly transport?: Transport;
}

export interface SitemapDiscoveryResult {
  readonly urls: readonly string[];
  readonly robots: RobotsTxt;
  /** Sitemap documents actually read, for the crawl's evidence trail. */
  readonly sitemapsRead: readonly string[];
}

async function fetchText(
  url: string,
  options: SitemapDiscoveryOptions,
): Promise<string | null> {
  try {
    const response = await safeFetch(url, {
      method: "GET",
      headers: { "user-agent": options.userAgent },
      timeoutMs: options.timeoutMs,
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
    return response.status >= 200 && response.status < 300 ? response.body.toString("utf8") : null;
  } catch (error) {
    // A missing or blocked sitemap is not a crawl failure — it is the reason the
    // link-following fallback exists.
    if (error instanceof SsrfBlockedError) return null;
    return null;
  }
}

/** Fetches and parses robots.txt; an absent file yields a "not present" result. */
export async function fetchRobots(options: SitemapDiscoveryOptions): Promise<RobotsTxt> {
  const content = await fetchText(`${options.siteOrigin}/robots.txt`, options);
  return content === null ? { groups: [], sitemaps: [], present: false } : parseRobotsTxt(content);
}

/**
 * Discovers page URLs from robots-declared sitemaps, then the conventional locations.
 *
 * Returns an empty list rather than throwing when nothing is found; the caller falls back
 * to following links from the homepage.
 */
export async function discoverFromSitemaps(
  options: SitemapDiscoveryOptions,
  robots: RobotsTxt,
): Promise<SitemapDiscoveryResult> {
  const candidates = [
    ...robots.sitemaps,
    `${options.siteOrigin}/sitemap.xml`,
    `${options.siteOrigin}/sitemap_index.xml`,
    `${options.siteOrigin}/sitemap-index.xml`,
  ];

  const seenDocuments = new Set<string>();
  const sitemapsRead: string[] = [];
  const urls = new Set<string>();

  const readDocument = async (documentUrl: string, allowIndex: boolean): Promise<void> => {
    if (urls.size >= options.maxUrls) return;
    if (seenDocuments.has(documentUrl)) return;
    seenDocuments.add(documentUrl);

    const xml = await fetchText(documentUrl, options);
    if (xml === null) return;
    sitemapsRead.push(documentUrl);

    const locations = parseSitemapLocations(xml);
    if (isSitemapIndex(xml) && allowIndex) {
      // One level only: an index of indexes is pathological and not worth the requests.
      for (const child of locations.slice(0, 50)) {
        await readDocument(child, false);
        if (urls.size >= options.maxUrls) return;
      }
      return;
    }

    for (const location of locations) {
      const normalized = normalizePageUrl(location);
      if (!normalized.ok) continue;
      // A sitemap listing somebody else's domain is either an error or an attack.
      if (
        normalized.value.hostname !== options.siteHost &&
        !normalized.value.hostname.endsWith(`.${options.siteHost}`)
      ) {
        continue;
      }
      urls.add(normalized.value.href);
      if (urls.size >= options.maxUrls) return;
    }
  };

  for (const candidate of candidates) {
    await readDocument(candidate, true);
    if (urls.size >= options.maxUrls) break;
  }

  return { urls: [...urls], robots, sitemapsRead };
}
