// Failure modes of wall-clock <-> instant conversion:
// 1. A local time inside a DST gap does not exist and must resolve forward.
// 2. A local time inside a DST overlap exists twice and must pick the earlier instant.
// 3. Offsets that are not whole hours (+05:30, +05:45) and 30-minute DST shifts.
// 4. Zones near the date line shift the local date, not only the hour.
// 5. DST days have 23 or 25 hours, so "9:00 to 17:00" must still be 8 hours.
// 6. An unknown zone name must fail loudly, not fall back to UTC.
// 7. Weekday and date arithmetic must not drift across month and year ends.
import { describe, expect, it } from "vitest";
import {
  addDays,
  isValidTimeZone,
  localToUtc,
  utcToLocal,
  weekdayOf,
} from "../../src/shared/time.ts";

const iso = (ms: number) => new Date(ms).toISOString();

describe("localToUtc", () => {
  it("converts an ordinary local time", () => {
    expect(iso(localToUtc("America/New_York", "2026-10-19", 9 * 60))).toBe(
      "2026-10-19T13:00:00.000Z",
    );
  });

  it("moves a time inside the spring-forward gap forward by the gap", () => {
    // 2026-03-08 02:30 does not exist in New York; it resolves to 03:30 EDT.
    expect(iso(localToUtc("America/New_York", "2026-03-08", 2 * 60 + 30))).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("picks the earlier instant inside the fall-back overlap", () => {
    // 2026-11-01 01:30 happens twice in New York; the first is EDT (-04:00).
    expect(iso(localToUtc("America/New_York", "2026-11-01", 60 + 30))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("handles offsets that are not whole hours", () => {
    expect(iso(localToUtc("Asia/Kolkata", "2026-10-19", 9 * 60))).toBe("2026-10-19T03:30:00.000Z");
    expect(iso(localToUtc("Asia/Kathmandu", "2026-10-19", 9 * 60))).toBe(
      "2026-10-19T03:15:00.000Z",
    );
  });

  it("handles a 30-minute DST shift", () => {
    // Lord Howe Island moves from +10:30 to +11:00 on 2026-10-04 at 02:00.
    expect(iso(localToUtc("Australia/Lord_Howe", "2026-10-05", 9 * 60))).toBe(
      "2026-10-04T22:00:00.000Z",
    );
  });

  it("shifts the date for zones near the date line", () => {
    // Kiritimati is +14:00: local 09:00 on the 19th is 19:00 UTC on the 18th.
    expect(iso(localToUtc("Pacific/Kiritimati", "2026-10-19", 9 * 60))).toBe(
      "2026-10-18T19:00:00.000Z",
    );
  });

  it("keeps an 8-hour working day on DST transition days", () => {
    for (const date of ["2026-03-08", "2026-11-01"]) {
      const start = localToUtc("America/New_York", date, 9 * 60);
      const end = localToUtc("America/New_York", date, 17 * 60);
      expect(end - start).toBe(8 * 3_600_000);
    }
  });

  it("gives a 23-hour and a 25-hour local day on transition days", () => {
    const day = (date: string) =>
      localToUtc("America/New_York", addDays(date, 1), 0) - localToUtc("America/New_York", date, 0);
    expect(day("2026-03-08")).toBe(23 * 3_600_000);
    expect(day("2026-11-01")).toBe(25 * 3_600_000);
  });

  it("accepts minute 1440 as the end of the day", () => {
    expect(localToUtc("UTC", "2026-10-19", 1440)).toBe(localToUtc("UTC", "2026-10-20", 0));
  });

  it("rejects an unknown time zone", () => {
    expect(() => localToUtc("Mars/Olympus_Mons", "2026-10-19", 0)).toThrow(/time zone/i);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("Europe/Lisbon")).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(() => localToUtc("UTC", "2026-13-01", 0)).toThrow(/date/i);
    expect(() => localToUtc("UTC", "2026-02-30", 0)).toThrow(/date/i);
  });
});

describe("utcToLocal", () => {
  it("returns local date, minute of day and ISO weekday", () => {
    expect(utcToLocal("Europe/Lisbon", Date.parse("2026-10-18T23:30:00Z"))).toEqual({
      date: "2026-10-19",
      minuteOfDay: 30,
      weekday: 1,
    });
  });

  it("round-trips every quarter hour across a fall-back day", () => {
    const zone = "Europe/Berlin";
    const start = Date.parse("2026-10-24T22:00:00Z");
    for (let t = start; t < start + 26 * 3_600_000; t += 15 * 60_000) {
      const local = utcToLocal(zone, t);
      const back = localToUtc(zone, local.date, local.minuteOfDay);
      // In the overlap, the second instant maps back to the first one.
      expect(back === t || back === t - 3_600_000).toBe(true);
    }
  });
});

describe("date arithmetic", () => {
  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-19", 14)).toBe("2026-11-02");
  });

  it("returns ISO weekdays, Monday = 1 and Sunday = 7", () => {
    expect(weekdayOf("2026-10-19")).toBe(1);
    expect(weekdayOf("2026-10-25")).toBe(7);
    expect(weekdayOf("2027-01-01")).toBe(5);
  });
});
