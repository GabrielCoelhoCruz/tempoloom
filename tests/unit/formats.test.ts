// Time and date formats and the display week (docs/specs/settings-profile.md PRF-6).
// Failure modes:
//  1. 12-hour times are wrong at midnight and noon, or 24-hour times lose the zero.
//  2. A date format puts day and month in the wrong order.
//  3. The display week of a Sunday start does not begin on the Sunday at or before the date.
//  4. A time in a zone uses the browser zone, not the user's.
import { describe, expect, it } from "vitest";
import { formatsOf } from "../../src/shared/formats.ts";
import { localToUtc } from "../../src/shared/time.ts";
import {
  clockSecondsText,
  dateText,
  dateTimeText,
  displayWeekOf,
  type Formats,
  formatWhen,
  hourText,
  sameWeekShown,
  timeText,
  weekdaysInOrder,
} from "../../src/web/lib/format.ts";

const H24: Formats = { time: "24h", date: "YMD", weekStart: 1 };
const H12: Formats = { time: "12h", date: "DMY", weekStart: 7 };
const US: Formats = { time: "12h", date: "MDY", weekStart: 7 };

describe("formats (PRF-6)", () => {
  it("writes times of day in 24 or 12 hours", () => {
    expect([0, 9 * 60 + 5, 12 * 60, 14 * 60 + 30, 1440].map((m) => timeText(m, H24))).toEqual([
      "00:00",
      "09:05",
      "12:00",
      "14:30",
      "24:00",
    ]);
    expect([0, 9 * 60 + 5, 12 * 60, 14 * 60 + 30, 1440].map((m) => timeText(m, H12))).toEqual([
      "12:00 AM",
      "9:05 AM",
      "12:00 PM",
      "2:30 PM",
      "12:00 AM",
    ]);
    expect([1, 12, 14].map((h) => hourText(h, H24))).toEqual(["01:00", "12:00", "14:00"]);
    expect([1, 12, 14].map((h) => hourText(h, H12))).toEqual(["1 AM", "12 PM", "2 PM"]);
  });

  it("writes dates in year-month-day, day-month-year or month-day-year", () => {
    expect(dateText("2026-11-09", H24)).toBe("2026-11-09");
    expect(dateText("2026-11-09", H12)).toBe("09/11/2026");
    expect(dateText("2026-11-09", US)).toBe("11/09/2026");
  });

  it("starts the display week on Monday or Sunday", () => {
    // 2026-11-08 is a Sunday, 2026-11-14 a Saturday.
    expect(displayWeekOf("2026-11-08", H24)).toBe("2026-11-02");
    expect(displayWeekOf("2026-11-14", H24)).toBe("2026-11-09");
    expect(displayWeekOf("2026-11-08", H12)).toBe("2026-11-08");
    expect(displayWeekOf("2026-11-14", H12)).toBe("2026-11-08");
    expect(weekdaysInOrder(H24)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekdaysInOrder(H12)).toEqual([7, 1, 2, 3, 4, 5, 6]);
  });

  it("writes a time in the user's zone", () => {
    const t = localToUtc("Asia/Tokyo", "2026-11-09", 14 * 60 + 30);
    expect(formatWhen("Asia/Tokyo", t, H24)).toBe("Mon 2026-11-09 14:30");
    expect(formatWhen("Asia/Tokyo", t, H12)).toBe("Mon 09/11/2026 2:30 PM");
    expect(dateTimeText("Europe/Berlin", t, US)).toBe("11/09/2026 6:30 AM");
    expect(clockSecondsText("Asia/Tokyo", t + 5_000, H24)).toBe("14:30:05");
    expect(clockSecondsText("Asia/Tokyo", t + 5_000, H12)).toBe("2:30:05 PM");
  });
});

describe("display week and planning week (PRF-6)", () => {
  it("takes the Google week start for displays, else the planning week start", () => {
    const base = { timeFormat: "24h", dateFormat: "YMD" } as const;
    expect(formatsOf({ ...base, weekStart: 7, googleWeekStart: null }).weekStart).toBe(7);
    expect(formatsOf({ ...base, weekStart: 1, googleWeekStart: 7 }).weekStart).toBe(7);
    expect(formatsOf({ ...base, weekStart: 7, googleWeekStart: 1 }).weekStart).toBe(1);
  });

  it("keeps most days of the week shown when the week start changes", () => {
    // Sunday 2026-11-08 to Saturday 11-14, then weeks from Monday: 11-09 (6 days stay), not 11-02.
    expect(sameWeekShown("2026-11-08", H24)).toBe("2026-11-09");
    // Monday 2026-11-09 to Sunday 11-15, then weeks from Sunday: 11-08 (6 days stay).
    expect(sameWeekShown("2026-11-09", H12)).toBe("2026-11-08");
    expect(sameWeekShown("2026-11-09", H24)).toBe("2026-11-09");
  });
});
