/**
 * URL identity — normalization, hashing, and the syntactic host policy.
 *
 * Two different URLs that name the same page must produce the same `url_hash`, or change
 * detection silently breaks and every re-crawl looks like a brand-new site. That makes
 * normalization a correctness concern, not a tidiness one, and it belongs in `domain/`
 * where it is pure and exhaustively testable.
 *
 * `node:crypto`'s `createHash` is used for the hash: it is synchronous, deterministic and
 * dependency-free — a language facility like `Math`, not infrastructure (§2.2).
 */
import { createHash } from "node:crypto";
import { isPubliclyRoutableIp, parseIp } from "./ip-policy.js";

export type UrlRejection =
  | "malformed"
  | "unsupported_scheme"
  | "unsupported_port"
  | "missing_host"
  | "non_public_host";

export interface NormalizedUrl {
  /** Canonical absolute URL. */
  readonly href: string;
  /** Lowercased hostname, punycode as provided by the URL parser. */
  readonly hostname: string;
  /** Scheme + host, no trailing slash — what a project's OWN site records. */
  readonly origin: string;
}

/** http/https only, on their default ports (Engineering-Rules §12). */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/**
 * Hostnames that can never be a customer's public website. This is the *syntactic* half of
 * the SSRF policy — literal loopback, link-local, RFC-1918 and reserved ranges, plus
 * reserved TLDs. The DNS-resolving half (rebinding protection, redirect re-validation)
 * lives in the crawler's SSRF guard, because it needs the network.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

const BLOCKED_TLDS = [".local", ".internal", ".localhost", ".home", ".lan", ".corp", ".test", ".example", ".invalid"];

/**
 * True when a hostname could plausibly belong to a public website.
 *
 * Deliberately conservative: a false negative costs a user one clear error message, while
 * a false positive points our crawler at someone's internal network.
 */
export function isPubliclyRoutableHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length === 0) return false;
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  // A literal address answers for itself; no DNS, no ambiguity.
  const literal = parseIp(host.replace(/^\[|\]$/g, ""));
  if (literal !== null) return isPubliclyRoutableIp(host.replace(/^\[|\]$/g, ""));
  if (BLOCKED_TLDS.some((tld) => host === tld.slice(1) || host.endsWith(tld))) return false;
  // A public site always has a dot; bare hostnames are intranet names.
  if (!host.includes(".")) return false;
  return true;
}

function parse(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // A bare "acme.com" is what people actually type; assume https rather than rejecting.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function validate(url: URL): UrlRejection | null {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return "unsupported_scheme";
  if (!ALLOWED_PORTS.has(url.port)) return "unsupported_port";
  if (url.hostname.length === 0) return "missing_host";
  if (!isPubliclyRoutableHostname(url.hostname)) return "non_public_host";
  return null;
}

/** Drops the `www.` prefix — `www.acme.com` and `acme.com` are one site (PRD FR-2.1). */
function canonicalHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

export type UrlResult =
  | { readonly ok: true; readonly value: NormalizedUrl }
  | { readonly ok: false; readonly reason: UrlRejection };

/**
 * Normalizes the root URL a project is created with: scheme lowercased and defaulted to
 * https, `www.` dropped, default port removed, path/query/fragment discarded.
 */
export function normalizeSiteUrl(input: string): UrlResult {
  const url = parse(input);
  if (url === null) return { ok: false, reason: "malformed" };
  const rejection = validate(url);
  if (rejection !== null) return { ok: false, reason: rejection };

  const hostname = canonicalHost(url.hostname);
  const origin = `${url.protocol}//${hostname}`;
  return { ok: true, value: { href: origin, hostname, origin } };
}

/**
 * Normalizes a page URL discovered during a crawl. Unlike a site root this keeps the path
 * and query — they distinguish real pages — but strips the fragment (never server-visible),
 * sorts query parameters so ordering cannot fork a page's identity, and removes a trailing
 * slash from non-root paths.
 */
export function normalizePageUrl(input: string, base?: string): UrlResult {
  let url: URL | null;
  if (base === undefined) {
    url = parse(input);
  } else {
    try {
      url = new URL(input, base);
    } catch {
      url = null;
    }
  }
  if (url === null) return { ok: false, reason: "malformed" };
  const rejection = validate(url);
  if (rejection !== null) return { ok: false, reason: rejection };

  const hostname = canonicalHost(url.hostname);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";

  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;

  const origin = `${url.protocol}//${hostname}`;
  return { ok: true, value: { href: `${origin}${path}${search}`, hostname, origin } };
}

/**
 * Stable identity for a page within a site. Hex SHA-256 of the normalized URL: fixed width
 * for the `(site_id, url_hash)` unique index, and immune to the length limits a raw URL
 * column would impose.
 */
export function urlHash(normalizedHref: string): string {
  return createHash("sha256").update(normalizedHref, "utf8").digest("hex");
}
