// Failure modes of fragmented time (docs/specs/teams-policies.md rule 21):
// 1. A short gap between two busy events inside work hours must count.
// 2. A gap of exactly the minimum block is usable, not fragmented.
// 3. Time between the start of work hours and the first event (or the last
//    event and the end) is not "between busy events" and must not count.
// 4. Overlapping or touching events must merge before gaps are measured.
// 5. Busy time outside work hours must not create gaps inside them.
// 6. Two work ranges of one day (a lunch break between them) are measured
//    apart: a gap across the break does not count.
// 7. The spec's example: meetings 10:00, 11:00 and 14:00 of 30 minutes with a
//    60-minute block give 30 minutes.
import { describe, expect, it } from "vitest";
import { fragmentedMinutes } from "../../src/server/analytics/fragmentation.ts";

const M = 60_000;
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return (h * 60 + m) * M;
};
const iv = (a: string, b: string) => ({ start: at(a), end: at(b) });
const work = [iv("09:00", "17:00")];

describe("fragmentedMinutes", () => {
  it("counts the spec example: 30 minutes between 10:30 and 11:00", () => {
    const busy = [iv("10:00", "10:30"), iv("11:00", "11:30"), iv("14:00", "14:30")];
    expect(fragmentedMinutes(busy, work, 60)).toBe(30);
  });

  it("treats a gap of exactly the minimum block as usable", () => {
    expect(fragmentedMinutes([iv("10:00", "11:00"), iv("12:00", "13:00")], work, 60)).toBe(0);
  });

  it("does not count time before the first or after the last event", () => {
    expect(fragmentedMinutes([iv("09:20", "16:40")], work, 60)).toBe(0);
  });

  it("merges overlapping and touching events before measuring gaps", () => {
    const busy = [
      iv("10:00", "11:00"),
      iv("10:30", "11:15"),
      iv("11:15", "11:30"),
      iv("11:45", "12:00"),
    ];
    expect(fragmentedMinutes(busy, work, 60)).toBe(15);
  });

  it("ignores busy time outside work hours", () => {
    const busy = [iv("08:00", "08:50"), iv("09:30", "10:00"), iv("17:10", "18:00")];
    expect(fragmentedMinutes(busy, work, 60)).toBe(0);
  });

  it("measures each work range of a day apart", () => {
    const split = [iv("09:00", "12:00"), iv("13:00", "17:00")];
    const busy = [iv("11:30", "12:00"), iv("13:00", "13:30"), iv("13:45", "14:00")];
    expect(fragmentedMinutes(busy, split, 60)).toBe(15);
  });
});
