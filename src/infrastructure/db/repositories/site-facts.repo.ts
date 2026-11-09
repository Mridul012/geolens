/**
 * The observable facts behind the deterministic score components (AI-Pipeline §3.5).
 *
 * ── Raw SQL justification (Engineering-Rules §5) ──────────────────────────────
 * Every one of these is a single aggregate over `page_snapshots`, and most read fields out
 * of the `extracted` JSONB — `canonical`, `metaDescription`, `signals.hasAuthor`,
 * `signals.outboundCitationCount`. Prisma cannot aggregate inside JSONB, and pulling a
 * hundred extraction artifacts into Node to count them would be absurd. One statement per
 * component, all parameters bound.
 *
 * Separate from `crawls.repo` because it answers a different question: that repo owns the
 * crawl's lifecycle and evidence, this one owns "what is true about this site" — the input
 * to the two components that can never degrade.
 */
import type { Database } from "../prisma.js";

export interface TechnicalPageFacts {
  readonly pagesTotal: number;
  readonly pagesWithStructuredData: number;
  readonly pagesWithCanonical: number;
  readonly pagesWithMetaDescription: number;
  readonly pagesWithTitle: number;
}

export interface TrustPageFacts {
  readonly contentPages: number;
  readonly pagesWithAuthor: number;
  readonly pagesWithOutboundCitations: number;
  readonly hasAboutPage: boolean;
  readonly hasContactPage: boolean;
  readonly hasDatedPolicyPage: boolean;
  /** True when every page that responded did so over HTTPS without a TLS failure. */
  readonly httpsValid: boolean;
}

/** A page the recommendation rules point at. */
export interface PageRefRow {
  readonly snapshotId: string;
  readonly url: string;
  readonly wordCount: number;
}

/** URL fragments that identify the three trust pages (AI-Pipeline §3.5). */
const ABOUT_PATTERNS = ["/about", "/company", "/who-we-are"];
const CONTACT_PATTERNS = ["/contact", "/support", "/get-in-touch"];
const POLICY_PATTERNS = ["/privacy", "/terms", "/editorial", "/policy", "/legal"];

/** A POSIX alternation for `~*`. The patterns are literal paths, so nothing needs escaping. */
function anyOf(patterns: readonly string[]): string {
  return `(${patterns.join("|")})`;
}

export class SiteFactsRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Page-level technical facts for one crawl.
   *
   * Counts only pages that actually responded: a 404 has no canonical tag and holding that
   * against the site would mean a broken link lowered its meta-hygiene score.
   *
   * Index: `page_snapshots(crawl_id, page_id)`.
   */
  async technicalFacts(crawlId: string): Promise<TechnicalPageFacts> {
    const rows = await this.#db.$queryRawUnsafe<
      Array<{
        pages_total: bigint;
        with_structured: bigint;
        with_canonical: bigint;
        with_description: bigint;
        with_title: bigint;
      }>
    >(
      `SELECT
         count(*)::bigint AS pages_total,
         count(*) FILTER (WHERE has_structured_data)::bigint AS with_structured,
         count(*) FILTER (
           WHERE coalesce(extracted->>'canonical', '') <> ''
         )::bigint AS with_canonical,
         count(*) FILTER (
           WHERE coalesce(extracted->>'metaDescription', '') <> ''
         )::bigint AS with_description,
         count(*) FILTER (WHERE coalesce(title, '') <> '')::bigint AS with_title
       FROM page_snapshots
       WHERE crawl_id = $1::uuid
         AND (http_status IS NULL OR http_status BETWEEN 200 AND 299)`,
      crawlId,
    );

    const row = rows[0];
    return {
      pagesTotal: Number(row?.pages_total ?? 0n),
      pagesWithStructuredData: Number(row?.with_structured ?? 0n),
      pagesWithCanonical: Number(row?.with_canonical ?? 0n),
      pagesWithMetaDescription: Number(row?.with_description ?? 0n),
      pagesWithTitle: Number(row?.with_title ?? 0n),
    };
  }

  /**
   * Pages the recommendation rules can name (M13).
   *
   * One statement per rule rather than one pass returning everything: each is a different
   * question, they are all cheap, and a combined query would need three `FILTER`s over a
   * `jsonb_array_elements` join that only one of them wants.
   */
  async thinPages(crawlId: string, maxWords: number, limit: number): Promise<readonly PageRefRow[]> {
    return this.#pageRefs(
      `SELECT s.id, p.url, coalesce(s.word_count, 0) AS word_count
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id
       WHERE s.crawl_id = $1::uuid
         AND (s.http_status IS NULL OR s.http_status BETWEEN 200 AND 299)
         AND coalesce(s.word_count, 0) < $2::int
       ORDER BY coalesce(s.word_count, 0) ASC, p.url ASC
       LIMIT $3::int`,
      [crawlId, maxWords, limit],
    );
  }

  /**
   * Pages with no sign of recent attention.
   *
   * A page with no date at all is *not* stale: plenty of reference content is undated and
   * perfectly current, and flagging every one of them would bury the pages that really
   * have rotted.
   */
  async stalePages(crawlId: string, olderThan: Date, limit: number): Promise<readonly PageRefRow[]> {
    return this.#pageRefs(
      `SELECT s.id, p.url, coalesce(s.word_count, 0) AS word_count
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id
       WHERE s.crawl_id = $1::uuid
         AND (s.http_status IS NULL OR s.http_status BETWEEN 200 AND 299)
         AND coalesce(s.page_updated_at, s.published_at) IS NOT NULL
         AND coalesce(s.page_updated_at, s.published_at) < $2::timestamptz
       ORDER BY coalesce(s.page_updated_at, s.published_at) ASC, p.url ASC
       LIMIT $3::int`,
      [crawlId, olderThan, limit],
    );
  }

  async pagesMissingMetaDescription(
    crawlId: string,
    limit: number,
  ): Promise<readonly PageRefRow[]> {
    return this.#pageRefs(
      `SELECT s.id, p.url, coalesce(s.word_count, 0) AS word_count
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id
       WHERE s.crawl_id = $1::uuid
         AND (s.http_status IS NULL OR s.http_status BETWEEN 200 AND 299)
         AND coalesce(s.extracted->>'metaDescription', '') = ''
       ORDER BY p.url ASC
       LIMIT $2::int`,
      [crawlId, limit],
    );
  }

  /**
   * Pages nothing else on the site links to.
   *
   * In-degree, not out-degree: `page_snapshots.internal_link_count` counts links *leaving*
   * a page, which is the opposite question. The inbound set comes from unnesting every
   * page's extracted links, which is why this is raw SQL — the alternative is loading
   * every extraction artifact into Node to build a graph.
   *
   * The site root is excluded by definition: a homepage nobody links to is a homepage,
   * not an orphan.
   */
  async orphanPages(
    crawlId: string,
    siteUrl: string,
    limit: number,
  ): Promise<readonly PageRefRow[]> {
    return this.#pageRefs(
      `WITH linked AS (
         SELECT DISTINCT link->>'href' AS href
         FROM page_snapshots s,
              LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(s.extracted->'links') = 'array'
                     THEN s.extracted->'links' ELSE '[]'::jsonb END
              ) AS link
         WHERE s.crawl_id = $1::uuid AND (link->>'internal')::boolean IS TRUE
       )
       SELECT s.id, p.url, coalesce(s.word_count, 0) AS word_count
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id
       WHERE s.crawl_id = $1::uuid
         AND (s.http_status IS NULL OR s.http_status BETWEEN 200 AND 299)
         AND p.url NOT IN (SELECT href FROM linked WHERE href IS NOT NULL)
         AND p.url <> $2
         AND p.url <> rtrim($2, '/')
         AND p.url <> rtrim($2, '/') || '/'
       ORDER BY p.url ASC
       LIMIT $3::int`,
      [crawlId, siteUrl, limit],
    );
  }

  /**
   * The page-shaped inputs to a comparison column (M16).
   *
   * One statement per site so both columns are derived identically — a comparison whose
   * two halves were computed differently is not a comparison.
   */
  async comparisonFacts(
    crawlId: string,
    freshSince: Date,
  ): Promise<{
    pagesTotal: number;
    datedPages: number;
    freshPages: number;
    blogPages: number;
    meanInternalLinks: number | null;
  }> {
    const rows = await this.#db.$queryRawUnsafe<
      Array<{
        pages_total: bigint;
        dated_pages: bigint;
        fresh_pages: bigint;
        blog_pages: bigint;
        mean_internal_links: number | null;
      }>
    >(
      `SELECT
         count(*)::bigint AS pages_total,
         count(*) FILTER (
           WHERE coalesce(s.page_updated_at, s.published_at) IS NOT NULL
         )::bigint AS dated_pages,
         count(*) FILTER (
           WHERE coalesce(s.page_updated_at, s.published_at) >= $2::timestamptz
         )::bigint AS fresh_pages,
         count(*) FILTER (WHERE p.url ~* '/(blog|news|insights|resources|articles)(/|$)')::bigint
           AS blog_pages,
         avg(coalesce(s.internal_link_count, 0))::float8 AS mean_internal_links
       FROM page_snapshots s
       JOIN pages p ON p.id = s.page_id
       WHERE s.crawl_id = $1::uuid
         AND (s.http_status IS NULL OR s.http_status BETWEEN 200 AND 299)`,
      crawlId,
      freshSince,
    );

    const row = rows[0];
    return {
      pagesTotal: Number(row?.pages_total ?? 0n),
      datedPages: Number(row?.dated_pages ?? 0n),
      freshPages: Number(row?.fresh_pages ?? 0n),
      blogPages: Number(row?.blog_pages ?? 0n),
      meanInternalLinks:
        row?.mean_internal_links === null || row?.mean_internal_links === undefined
          ? null
          : Number(row.mean_internal_links),
    };
  }

  async #pageRefs(sql: string, params: readonly unknown[]): Promise<readonly PageRefRow[]> {
    const rows = await this.#db.$queryRawUnsafe<
      Array<{ id: string; url: string; word_count: number }>
    >(sql, ...params);
    return rows.map((row) => ({
      snapshotId: row.id,
      url: row.url,
      wordCount: Number(row.word_count),
    }));
  }

  /**
   * Trust signals for one crawl.
   *
   * "Content pages" excludes thin pages deliberately: requiring an author byline on a
   * contact form would punish sites for having ordinary navigation, and the signal is
   * about whether *articles* are attributable.
   */
  async trustFacts(crawlId: string, minContentWords: number): Promise<TrustPageFacts> {
    const rows = await this.#db.$queryRawUnsafe<
      Array<{
        content_pages: bigint;
        with_author: bigint;
        with_citations: bigint;
        about_pages: bigint;
        contact_pages: bigint;
        dated_policy_pages: bigint;
        non_https: bigint;
      }>
    >(
      `SELECT
         count(*) FILTER (WHERE coalesce(s.word_count, 0) >= $2::int)::bigint AS content_pages,
         count(*) FILTER (
           WHERE coalesce(s.word_count, 0) >= $2::int
             AND (s.extracted->'signals'->>'hasAuthor')::boolean IS TRUE
         )::bigint AS with_author,
         count(*) FILTER (
           WHERE coalesce(s.word_count, 0) >= $2::int
             AND coalesce((s.extracted->'signals'->>'outboundCitationCount')::int, 0) > 0
         )::bigint AS with_citations,
         count(*) FILTER (WHERE p.url ~* $3)::bigint AS about_pages,
         count(*) FILTER (WHERE p.url ~* $4)::bigint AS contact_pages,
         count(*) FILTER (
           WHERE p.url ~* $5 AND (s.page_updated_at IS NOT NULL OR s.published_at IS NOT NULL)
         )::bigint AS dated_policy_pages,
         count(*) FILTER (WHERE p.url NOT LIKE 'https://%')::bigint AS non_https
       FROM page_snapshots s
       JOIN pages p ON p.id = s.page_id
       WHERE s.crawl_id = $1::uuid
         AND (s.http_status IS NULL OR s.http_status BETWEEN 200 AND 299)`,
      crawlId,
      minContentWords,
      anyOf(ABOUT_PATTERNS),
      anyOf(CONTACT_PATTERNS),
      anyOf(POLICY_PATTERNS),
    );

    const row = rows[0];
    const nonHttps = Number(row?.non_https ?? 0n);
    return {
      contentPages: Number(row?.content_pages ?? 0n),
      pagesWithAuthor: Number(row?.with_author ?? 0n),
      pagesWithOutboundCitations: Number(row?.with_citations ?? 0n),
      hasAboutPage: Number(row?.about_pages ?? 0n) > 0,
      hasContactPage: Number(row?.contact_pages ?? 0n) > 0,
      hasDatedPolicyPage: Number(row?.dated_policy_pages ?? 0n) > 0,
      // Pages were fetched through the guarded client, which fails a bad certificate
      // outright — so a page that responded over https did so with a valid one.
      httpsValid: nonHttps === 0,
    };
  }
}
