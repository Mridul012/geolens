/**
 * robots.txt parsing and evaluation — pure.
 *
 * Serves two callers with different stakes. The crawler asks "may *we* fetch this?", and
 * getting it wrong makes us a bad citizen (PRD security commitments: robots.txt honored,
 * opt-outs same-day). The AI crawler access check asks "may *GPTBot* fetch this?", and
 * getting that wrong is the product telling a customer something false about their own
 * site — the single most damaging kind of bug this codebase can ship.
 *
 * Implements the Google/RFC-9309 semantics the major crawlers actually follow:
 * most-specific group wins, longest matching rule wins, `Allow` breaks a tie, `*` and `$`
 * are the only wildcards.
 */

export interface RobotsRule {
  readonly type: "allow" | "disallow";
  readonly path: string;
}

export interface RobotsGroup {
  /** Lower-cased user-agent tokens this group applies to. */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly crawlDelaySeconds: number | null;
}

export interface RobotsTxt {
  readonly groups: readonly RobotsGroup[];
  /** Sitemap URLs are global — they belong to no group. */
  readonly sitemaps: readonly string[];
  /** True when the file existed and parsed; false when absent or unreadable. */
  readonly present: boolean;
}

export const EMPTY_ROBOTS: RobotsTxt = { groups: [], sitemaps: [], present: false };

/** U+FEFF, the UTF-8 byte-order mark. */
const BOM_CODE_POINT = 0xfeff;

/**
 * Parses robots.txt.
 *
 * Tolerant by design: unknown directives, stray blank lines and BOMs are ignored rather
 * than failing the parse, because a malformed file must still yield the rules it does
 * contain — that is how real crawlers behave, and how our verdicts stay comparable.
 */
export function parseRobotsTxt(content: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let currentAgents: string[] = [];
  let currentRules: RobotsRule[] = [];
  let currentDelay: number | null = null;
  // Consecutive `User-agent` lines share one group; a rule closes the agent list.
  let collectingAgents = false;

  const flush = (): void => {
    if (currentAgents.length > 0) {
      groups.push({
        agents: currentAgents,
        rules: currentRules,
        crawlDelaySeconds: currentDelay,
      });
    }
    currentAgents = [];
    currentRules = [];
    currentDelay = null;
  };

  // A UTF-8 BOM is common on Windows-authored robots.txt and, left in place, corrupts the
  // first directive name. Compared by code point rather than written as a literal, which
  // would be an invisible character in the source.
  const body = content.codePointAt(0) === BOM_CODE_POINT ? content.slice(1) : content;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case "user-agent": {
        if (!collectingAgents) {
          flush();
          collectingAgents = true;
        }
        if (value.length > 0) currentAgents.push(value.toLowerCase());
        break;
      }
      case "allow":
      case "disallow": {
        collectingAgents = false;
        // `Disallow:` with an empty value means "allow everything" — not a rule.
        if (field === "disallow" && value.length === 0) break;
        if (value.length === 0) break;
        currentRules.push({ type: field, path: value });
        break;
      }
      case "crawl-delay": {
        collectingAgents = false;
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) currentDelay = parsed;
        break;
      }
      case "sitemap": {
        if (value.length > 0) sitemaps.push(value);
        break;
      }
      default:
        break;
    }
  }
  flush();

  return { groups, sitemaps, present: true };
}

/**
 * Selects the group governing a user agent.
 *
 * Exact token match wins over `*`; among exact matches the longest token wins, so
 * `Googlebot-News` is preferred over `Googlebot`. Matching is case-insensitive and on
 * substring, which is how crawlers interpret their own product tokens.
 */
export function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const agent = userAgent.toLowerCase();
  let best: { group: RobotsGroup; score: number } | null = null;

  for (const group of robots.groups) {
    for (const token of group.agents) {
      if (token === "*") {
        if (best === null) best = { group, score: 0 };
        continue;
      }
      if (agent.includes(token)) {
        const score = token.length;
        if (best === null || best.score < score) best = { group, score };
      }
    }
  }

  return best?.group ?? null;
}

/**
 * Does `pattern` match `path`?
 *
 * `*` matches any run of characters, `$` anchors the end. Everything else is literal, and
 * a pattern is a prefix match unless anchored — the semantics the major crawlers document.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const escaped = body
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}

export interface RobotsVerdict {
  readonly allowed: boolean;
  /** The rule that decided it, for evidence in the access check. */
  readonly matchedRule: RobotsRule | null;
  /** The user-agent token whose group applied, or "*". */
  readonly matchedAgent: string | null;
}

/**
 * May `userAgent` fetch `path`?
 *
 * The default is **allowed**: an absent robots.txt, an unparseable one, or one with no
 * applicable group all permit crawling. That is the standard's default and, importantly,
 * the honest answer for the access check — reporting "blocked" because a file is missing
 * would be a false alarm on the product's highest-value finding.
 */
export function isPathAllowed(
  robots: RobotsTxt,
  userAgent: string,
  path: string,
): RobotsVerdict {
  if (!robots.present) return { allowed: true, matchedRule: null, matchedAgent: null };

  const group = groupFor(robots, userAgent);
  if (group === null) return { allowed: true, matchedRule: null, matchedAgent: null };

  const matchedAgent =
    group.agents.find((token) => userAgent.toLowerCase().includes(token)) ?? "*";

  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!matchesPattern(rule.path, path)) continue;
    if (best === null) {
      best = rule;
      continue;
    }
    // Longest match wins; on equal length, Allow beats Disallow.
    if (rule.path.length > best.path.length) best = rule;
    else if (rule.path.length === best.path.length && rule.type === "allow") best = rule;
  }

  return {
    allowed: best === null || best.type === "allow",
    matchedRule: best,
    matchedAgent,
  };
}

/** Convenience for the crawler's own politeness checks. */
export function crawlDelayFor(robots: RobotsTxt, userAgent: string): number | null {
  return groupFor(robots, userAgent)?.crawlDelaySeconds ?? null;
}
