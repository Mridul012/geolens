/**
 * The PublicSuffix port over `tldts`.
 *
 * `tldts` ships the Mozilla public-suffix list, which is the only correct way to know that
 * `example.co.uk` is a registrable domain and `co.uk` is not. Hand-rolling it with a
 * "last two labels" rule is the classic bug that makes every UK customer's citations
 * resolve to the wrong owner.
 */
import { parse } from "tldts";
import type { PublicSuffix } from "../../application/ports/public-suffix.port.js";

export class TldtsPublicSuffix implements PublicSuffix {
  registrableDomain(urlOrHost: string): string | null {
    const parsed = parse(urlOrHost.trim());
    // `domain` is null for an IP address, a public suffix on its own, or garbage — all of
    // which are "not a site we can attribute a citation to".
    return parsed.domain === null || parsed.domain === undefined ? null : parsed.domain;
  }
}
