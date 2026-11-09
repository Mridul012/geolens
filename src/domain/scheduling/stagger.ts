/**
 * Weekly stagger (docs/Backend.md §5, §13 — "staggered by project hash in project
 * timezone"). Pure and deterministic: a project always lands on the same hour of its own
 * week, computed with no shared state, so ten thousand projects spread themselves evenly
 * across 168 hourly ticks without any coordination between workers.
 */

const HOURS_PER_WEEK = 24 * 7;

/** FNV-1a — small, dependency-free, and stable across Node versions. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A project's fixed weekly slot, as hours since the start of its local week (0–167). */
export function weeklySlotHour(projectId: string): number {
  return fnv1a(projectId) % HOURS_PER_WEEK;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * `instant`'s hour-of-week (0–167) in `timezone` — Sunday 00:00 local time is 0.
 *
 * Built on `Intl.DateTimeFormat` rather than a date library: this is the one place a
 * project's IANA timezone needs to become a local day-of-week and hour, and the platform
 * already does that correctly, including DST transitions.
 */
export function localHourOfWeek(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(instant);

  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const dayOfWeek = WEEKDAY_INDEX[weekday] ?? 0;
  return dayOfWeek * 24 + hour;
}

/**
 * Whether `projectId`'s weekly slot falls in the current tick.
 *
 * `offsetHours` lets a dependent job (prompt-sim after the crawl, a digest after that)
 * declare its distance from the project's one anchor slot, so every scheduled concern for
 * a project stays predictably ordered relative to the others without a second hash.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A stable identifier for the 7-day period `instant` falls in, used only to make a
 * once-per-week job id deterministic (e.g. `digest-{projectId}-{weekBucket}`). It does not
 * need to align with the ISO calendar week — only to increment exactly every 7 days so
 * enqueuing twice in the same week is the same jobId, and BullMQ's own dedupe does the
 * rest.
 */
export function weekBucket(instant: Date): string {
  return String(Math.floor(instant.getTime() / WEEK_MS));
}

export function isDueThisHour(
  projectId: string,
  timezone: string,
  now: Date,
  offsetHours = 0,
): boolean {
  const target = (weeklySlotHour(projectId) + offsetHours) % HOURS_PER_WEEK;
  return target === localHourOfWeek(now, timezone);
}
