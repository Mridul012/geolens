/**
 * Weekly stagger (M18) — deterministic, timezone-aware slot assignment.
 */
import { describe, expect, it } from "vitest";
import {
  isDueThisHour,
  localHourOfWeek,
  weeklySlotHour,
} from "../../../src/domain/scheduling/stagger.js";

describe("weeklySlotHour", () => {
  it("is stable for the same project id", () => {
    expect(weeklySlotHour("project-a")).toBe(weeklySlotHour("project-a"));
  });

  it("differs for different project ids (spreads load)", () => {
    const slots = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => weeklySlotHour(id)),
    );
    // Not a strict guarantee for any hash, but collisions across 8 distinct short ids and
    // a 168-slot space would be a red flag for the hash, not bad luck.
    expect(slots.size).toBeGreaterThan(1);
  });

  it("always lands within one week of hours", () => {
    for (const id of ["x", "y", "z", "01a05108-0000-7000-8000-00000000aaaa"]) {
      const slot = weeklySlotHour(id);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(24 * 7);
    }
  });
});

describe("localHourOfWeek", () => {
  it("reads Sunday midnight UTC as hour 0", () => {
    // 2026-08-30 was a Sunday.
    expect(localHourOfWeek(new Date("2026-08-30T00:00:00.000Z"), "UTC")).toBe(0);
  });

  it("reads Monday noon UTC as 24 + 12", () => {
    expect(localHourOfWeek(new Date("2026-08-31T12:00:00.000Z"), "UTC")).toBe(24 + 12);
  });

  it("shifts by timezone — the same instant, different local hours", () => {
    const instant = new Date("2026-08-31T02:00:00.000Z"); // Monday 02:00 UTC
    const utc = localHourOfWeek(instant, "UTC");
    // America/Los_Angeles is behind UTC, so the local instant falls on Sunday evening.
    const la = localHourOfWeek(instant, "America/Los_Angeles");
    expect(la).toBeLessThan(utc);
  });
});

describe("isDueThisHour", () => {
  it("is true only at the project's own weekly slot", () => {
    const projectId = "01a05108-0000-7000-8000-00000000aaaa";
    const slot = weeklySlotHour(projectId);
    const dayOfWeek = Math.floor(slot / 24);
    const hourOfDay = slot % 24;

    // Construct a UTC instant whose localHourOfWeek matches the target slot exactly.
    // 2026-08-30 is a Sunday (hour-of-week 0 at 00:00 UTC).
    const due = new Date(
      Date.UTC(2026, 7, 30 + dayOfWeek, hourOfDay, 0, 0),
    );
    const notDue = new Date(due.getTime() + 60 * 60 * 1000);

    expect(isDueThisHour(projectId, "UTC", due)).toBe(true);
    expect(isDueThisHour(projectId, "UTC", notDue)).toBe(false);
  });

  it("shifts due-ness by the given offset", () => {
    const projectId = "01a05108-0000-7000-8000-00000000bbbb";
    const slot = weeklySlotHour(projectId);
    const dayOfWeek = Math.floor(slot / 24);
    const hourOfDay = slot % 24;
    const anchor = new Date(Date.UTC(2026, 7, 30 + dayOfWeek, hourOfDay, 0, 0));
    const fourHoursLater = new Date(anchor.getTime() + 4 * 60 * 60 * 1000);

    expect(isDueThisHour(projectId, "UTC", anchor, 4)).toBe(false);
    expect(isDueThisHour(projectId, "UTC", fourHoursLater, 4)).toBe(true);
  });
});
