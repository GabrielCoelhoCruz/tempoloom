// Failure modes of converting weekly hours to absolute time:
// 1. On DST days, 09:00-17:00 local must still be 8 hours at the right instants.
// 2. The range can start or end in the middle of a window; windows must be clipped.
// 3. A day without hours must contribute nothing.
// 4. Overlapping windows on one day must merge, not double count.
// 5. A window that ends at 24:00 must end at the next local midnight.
// 6. Weekday mapping must use the local date, not the UTC date.
import { describe, expect, it } from "vitest";
import { hoursToTimeSet, type WeeklyHours } from "../../src/scheduler/hours.ts";
import { localToUtc } from "../../src/shared/time.ts";

const NY = "America/New_York";
const weekdays9to17: WeeklyHours = {
  1: [[540, 1020]],
  2: [[540, 1020]],
  3: [[540, 1020]],
  4: [[540, 1020]],
  5: [[540, 1020]],
};

describe("hoursToTimeSet", () => {
  it("keeps 8-hour windows across the fall-back weekend", () => {
    const from = localToUtc(NY, "2026-10-30", 0);
    const to = localToUtc(NY, "2026-11-03", 0);
    const set = hoursToTimeSet(weekdays9to17, NY, from, to);
    expect(set.intervals().map((i) => new Date(i.start).toISOString())).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
    expect(set.total()).toBe(16 * 3_600_000);
  });

  it("clips windows at the range ends", () => {
    const from = localToUtc(NY, "2026-10-19", 12 * 60);
    const to = localToUtc(NY, "2026-10-20", 10 * 60);
    const set = hoursToTimeSet(weekdays9to17, NY, from, to);
    expect(set.total()).toBe((5 + 1) * 3_600_000);
  });

  it("merges overlapping windows and handles a window that ends at midnight", () => {
    const hours: WeeklyHours = {
      6: [
        [1200, 1440],
        [1300, 1380],
      ],
    };
    const from = localToUtc(NY, "2026-10-24", 0);
    const to = localToUtc(NY, "2026-10-26", 0);
    const set = hoursToTimeSet(hours, NY, from, to);
    expect(set.intervals()).toEqual([
      { start: localToUtc(NY, "2026-10-24", 1200), end: localToUtc(NY, "2026-10-25", 0) },
    ]);
  });

  it("maps weekdays by local date", () => {
    // Monday 00:30 in Tokyo is still Sunday in UTC.
    const hours: WeeklyHours = { 1: [[0, 60]] };
    const from = Date.parse("2026-10-18T00:00:00Z");
    const to = Date.parse("2026-10-20T00:00:00Z");
    const set = hoursToTimeSet(hours, "Asia/Tokyo", from, to);
    expect(set.intervals()).toEqual([
      { start: Date.parse("2026-10-18T15:00:00Z"), end: Date.parse("2026-10-18T16:00:00Z") },
    ]);
  });
});
