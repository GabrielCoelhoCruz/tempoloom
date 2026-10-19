// Failure modes of a composite (travel) zone, timezones-home-and-travel.md:
// 1. A local time on a travel day must resolve in the travel zone, and the
//    days before and after the trip in the home zone.
// 2. A one-day trip changes the zone twice within two days; the travel zone
//    must still win on that day.
// 3. Instant -> local must use the travel zone inside the trip (round trip).
// 4. The trip leg is half-open: its end instant is home time again.
// 5. On the day a trip starts the local day is short; hours must not run past
//    it into the travel zone's night.
// 6. On the day a trip ends the local day is long; hours must resolve once,
//    to the travel zone's instants.
// 7. A composite with no legs is the plain home zone.
import { describe, expect, it } from "vitest";
import { hoursToTimeSet, type WeeklyHours } from "../../src/scheduler/hours.ts";
import { localToUtc, travelZone, utcToLocal, zoneAt } from "../../src/shared/time.ts";

const HOME = "Europe/Berlin";
const TOKYO = "Asia/Tokyo";
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);
// Tuesday 2026-11-10 to Thursday 2026-11-12 in Tokyo: 00:00 Tue to 24:00 Thu Tokyo time.
const trip = travelZone(HOME, [
  { zone: TOKYO, start: ms("2026-11-09T15:00:00Z"), end: ms("2026-11-12T15:00:00Z") },
]);

describe("travel zone", () => {
  it("reads wall-clock times in the travel zone on travel days only", () => {
    expect(iso(localToUtc(trip, "2026-11-09", 540))).toBe("2026-11-09T08:00:00.000Z");
    expect(iso(localToUtc(trip, "2026-11-10", 540))).toBe("2026-11-10T00:00:00.000Z");
    expect(iso(localToUtc(trip, "2026-11-12", 540))).toBe("2026-11-12T00:00:00.000Z");
    expect(iso(localToUtc(trip, "2026-11-13", 540))).toBe("2026-11-13T08:00:00.000Z");
  });

  it("keeps the travel zone on a one-day trip", () => {
    const day = travelZone(HOME, [
      { zone: TOKYO, start: ms("2026-11-10T15:00:00Z"), end: ms("2026-11-11T15:00:00Z") },
    ]);
    expect(iso(localToUtc(day, "2026-11-11", 540))).toBe("2026-11-11T00:00:00.000Z");
    expect(iso(localToUtc(day, "2026-11-12", 540))).toBe("2026-11-12T08:00:00.000Z");
  });

  it("converts instants to travel-zone wall clock inside the trip", () => {
    expect(utcToLocal(trip, ms("2026-11-11T03:00:00Z"))).toEqual({
      date: "2026-11-11",
      minuteOfDay: 720,
      weekday: 3,
    });
    expect(utcToLocal(trip, ms("2026-11-13T11:00:00Z")).minuteOfDay).toBe(720);
  });

  it("ends the leg at its end instant", () => {
    expect(zoneAt(trip, ms("2026-11-12T14:59:00Z"))).toBe(TOKYO);
    expect(zoneAt(trip, ms("2026-11-12T15:00:00Z"))).toBe(HOME);
    expect(zoneAt(trip, ms("2026-11-09T14:59:00Z"))).toBe(HOME);
    expect(zoneAt(HOME, ms("2026-11-11T00:00:00Z"))).toBe(HOME);
  });

  it("is the home zone when there are no legs", () => {
    expect(travelZone(HOME, [])).toBe(HOME);
  });

  it("cuts hours at the end of the short day when the trip starts", () => {
    const weekdays: WeeklyHours = {
      1: [[540, 1020]],
      2: [[540, 1020]],
      3: [[540, 1020]],
      4: [[540, 1020]],
      5: [[540, 1020]],
    };
    const set = hoursToTimeSet(weekdays, trip, ms("2026-11-09T00:00:00Z"), ms("2026-11-14T00:00:00Z"));
    expect(set.intervals().map((i) => [iso(i.start), iso(i.end)])).toEqual([
      // Monday at home ends when Tuesday starts in Tokyo (16:00 Berlin).
      ["2026-11-09T08:00:00.000Z", "2026-11-09T15:00:00.000Z"],
      ["2026-11-10T00:00:00.000Z", "2026-11-10T08:00:00.000Z"],
      ["2026-11-11T00:00:00.000Z", "2026-11-11T08:00:00.000Z"],
      // Thursday's long day resolves once, in Tokyo.
      ["2026-11-12T00:00:00.000Z", "2026-11-12T08:00:00.000Z"],
      ["2026-11-13T08:00:00.000Z", "2026-11-13T16:00:00.000Z"],
    ]);
  });
});
