/**
 * What counts as a content page (AI-Pipeline §3.5).
 *
 * The trust signals ask whether *articles* are attributable and cite their sources.
 * Applying them to every page would punish a site for having a contact form, so the
 * threshold separates prose from navigation. Its own file because both the trust
 * component and, later, the recommendations engine need the same definition.
 */
export const MIN_CONTENT_WORDS = 200;

/**
 * How recently a page must have been written or updated to count as fresh (M16).
 *
 * A year, because most B2B content has a useful life of roughly that before a reader
 * starts checking the date. Only pages that *say* when they were written are measured
 * against it — a site that dates nothing scores null rather than stale.
 */
export const FRESHNESS_WINDOW_DAYS = 365;
