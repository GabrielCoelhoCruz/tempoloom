// addLocalDays: the same local wall-clock time N calendar days later in a
// zone. Ways it can fail:
// 1. It adds N x 24 hours: across a DST change the result moves by one hour,
//    and near midnight by one day.
// 2. It drops the seconds of the start instant.
// 3. A start in the second pass of a repeated hour (fall back) comes out one
//    hour late, or a 0-day step moves it to the first pass.
// 4. A target time in a DST gap (also a gap at midnight) is not a real time.
import { describe, expect, it } from "vitest";
import { addLocalDays, utcToLocal } from "../../src/shared/time.ts";

const wall = (zone: string, t: number) => {
  const l = utcToLocal(zone, t);
  const hh = String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0");
  const mm = String(l.minuteOfDay % 60).padStart(2, "0");
  return `${l.date} ${hh}:${mm}`;
};
const at = (iso: string) => Date.parse(iso);

describe("addLocalDays", () => {
  it.each([
    // America/New_York: spring forward 2026-03-08, fall back 2026-11-01.
    ["America/New_York", "2026-03-07T05:30:00Z", 3, "2026-03-10 00:30"],
    ["America/New_York", "2026-03-10T04:30:00Z", -3, "2026-03-07 00:30"],
    ["America/New_York", "2026-10-31T03:30:00Z", 3, "2026-11-02 23:30"],
    ["America/New_York", "2026-11-03T04:30:00Z", -3, "2026-10-30 23:30"],
    // Europe/Lisbon: spring forward 2026-03-29, fall back 2026-10-25.
    ["Europe/Lisbon", "2026-03-27T23:30:00Z", 3, "2026-03-30 23:30"],
    ["Europe/Lisbon", "2026-10-23T23:30:00Z", 3, "2026-10-27 00:30"],
    ["Europe/Lisbon", "2026-10-26T00:30:00Z", -3, "2026-10-23 00:30"],
    // America/Santiago changes at midnight: back on 2026-04-05, forward on 2026-09-06.
    ["America/Santiago", "2026-04-03T03:30:00Z", 3, "2026-04-06 00:30"],
    ["America/Santiago", "2026-09-05T03:30:00Z", 2, "2026-09-06 23:30"],
  ])("%s %s %+d days is %s local", (zone, start, days, expected) => {
    expect(wall(zone, addLocalDays(at(start), days, zone))).toBe(expected);
  });

  it("keeps the seconds", () => {
    expect(addLocalDays(at("2026-03-07T15:00:42.500Z"), 3, "America/New_York")).toBe(
      at("2026-03-10T14:00:42.500Z"),
    );
  });

  it("is the start itself for 0 days, also in the second pass of a repeated hour", () => {
    // 01:30 EST on 2026-11-01, the second 01:30 of that day.
    const second = at("2026-11-01T06:30:00Z");
    expect(addLocalDays(second, 0, "America/New_York")).toBe(second);
  });

  it("keeps the wall time from the second pass of a repeated hour", () => {
    // 01:30 WET on 2026-10-25 (second pass) + 30 days = 2026-11-24 01:30 WET.
    const t = addLocalDays(at("2026-10-25T01:30:00Z"), 30, "Europe/Lisbon");
    expect(t).toBe(at("2026-11-24T01:30:00Z"));
    // 01:30 EST on 2026-11-01 (second pass) + 7 days = 2026-11-08 01:30 EST.
    expect(addLocalDays(at("2026-11-01T06:30:00Z"), 7, "America/New_York")).toBe(
      at("2026-11-08T06:30:00Z"),
    );
  });

  it("moves a target in a gap forward by the gap", () => {
    // 02:30 on 2026-03-08 does not exist in New York; 03:30 EDT does.
    expect(
      wall("America/New_York", addLocalDays(at("2026-03-07T07:30:00Z"), 1, "America/New_York")),
    ).toBe("2026-03-08 03:30");
    // 00:30 on 2026-09-06 does not exist in Santiago; 01:30 does.
    expect(
      wall("America/Santiago", addLocalDays(at("2026-09-05T04:30:00Z"), 1, "America/Santiago")),
    ).toBe("2026-09-06 01:30");
  });
});
