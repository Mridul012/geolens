/**
 * Registrable-domain resolution behind a port (Engineering-Rules §2.2).
 *
 * Citation matching turns on eTLD+1 — `blog.geolens.com` and `geolens.com` are the same
 * business citing itself, while `notgeolens.com` is somebody else. Getting that right needs
 * the public-suffix list, which is a dependency and a data file, so it lives in
 * infrastructure and the pure matching code is handed the answers.
 *
 * Naive suffix matching is explicitly forbidden by AI-Pipeline §4.3, and this port is why
 * it cannot creep back in: the domain layer has no way to do it.
 */
export interface PublicSuffix {
  /** eTLD+1 for a URL or host, or null when there isn't one (an IP, an invalid host). */
  registrableDomain(urlOrHost: string): string | null;
}
