// snoozeUntil: the new start date of a snoozed task (planning-tasks.md TSK-24).
// Ways it can fail:
// 1. "1 hour" or "3 hours" does not count from now.
// 2. "Tomorrow" ignores the start of the hours, or picks a day with no hours.
// 3. "Next week" ignores the week start setting, or gives today's week on its first day.
// 4. A DST change moves the start of the hours by one hour.
import { describe, expect, it } from "vitest";
import type { WeeklyHours } from "../../src/scheduler/hours.ts";
import { snoozeUntil } from "../../src/server/snooze.ts";
import { localToUtc, utcToLocal } from "../../src/shared/time.ts";

const Z = "Europe/Berlin";
const at = (date: string, hh: number, mm = 0) => localToUtc(Z, date, hh * 60 + mm);
const wall = (t: number) => {
  const l = utcToLocal(Z, t);
  return `${l.date} ${String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0")}:${String(l.minuteOfDay % 60).padStart(2, "0")}`;
};
const work: WeeklyHours = Object.fromEntries(
  [1, 2, 3, 4, 5].map((d) => [d, [[9 * 60, 12 * 60] as const, [13 * 60, 17 * 60] as const]]),
);
const evenings: WeeklyHours = { 6: [[18 * 60, 21 * 60]], 2: [[19 * 60, 20 * 60]] };

describe("snoozeUntil", () => {
  // 2026-10-21 is a Wednesday.
  const now = at("2026-10-21", 15, 7);

  it("counts 1 hour and 3 hours from now", () => {
    expect(snoozeUntil("1h", now, Z, work, 1)).toBe(now + 3_600_000);
    expect(snoozeUntil("3h", now, Z, work, 1)).toBe(now + 3 * 3_600_000);
  });

  it("starts tomorrow at the start of the hours", () => {
    expect(wall(snoozeUntil("tomorrow", now, Z, work, 1))).toBe("2026-10-22 09:00");
  });

  it("moves tomorrow to the next day with hours", () => {
    const friday = at("2026-10-23", 10);
    expect(wall(snoozeUntil("tomorrow", friday, Z, work, 1))).toBe("2026-10-26 09:00");
    expect(wall(snoozeUntil("tomorrow", now, Z, evenings, 1))).toBe("2026-10-24 18:00");
  });

  it("starts next week on its first day, by the week start setting", () => {
    expect(wall(snoozeUntil("next-week", now, Z, work, 1))).toBe("2026-10-26 09:00");
    // Week starts on Sunday; Sunday has no work hours, so Monday 09:00.
    expect(wall(snoozeUntil("next-week", now, Z, work, 7))).toBe("2026-10-26 09:00");
    expect(wall(snoozeUntil("next-week", now, Z, evenings, 7))).toBe("2026-10-27 19:00");
  });

  it("gives next week, not this week, on the first day of a week", () => {
    const monday = at("2026-10-19", 8);
    expect(wall(snoozeUntil("next-week", monday, Z, work, 1))).toBe("2026-10-26 09:00");
  });

  it("keeps the local start across a DST change", () => {
    // Summer time ends on 2026-10-25.
    const saturday = at("2026-10-24", 12);
    expect(wall(snoozeUntil("tomorrow", saturday, Z, work, 1))).toBe("2026-10-26 09:00");
    expect(snoozeUntil("tomorrow", saturday, Z, work, 1)).toBe(Date.parse("2026-10-26T08:00:00Z"));
  });
});
