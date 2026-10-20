// One-off link expiry (docs/specs/booking-links-sharing.md rule 14): the link
// expires 30 days after creation, counted in the creator's zone. Ways it can fail:
// 1. The lifetime is counted as 30 x 24 hours: across a DST change the expiry
//    falls on the day before (or after) the 30th local day.
// 2. The days are counted in UTC: near local midnight the date is a day off.
// 3. A source link (not one-off) gets an expiry.
import { describe, expect, it } from "vitest";
import { oneOffExpiry } from "../../src/server/api/booking.ts";
import { utcToLocal } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const link = (createdAt: string, sourceId: string | null = "src") => ({
  source_id: sourceId,
  created_at: Date.parse(createdAt),
});
const localOf = (t: number | null) => {
  const l = utcToLocal(ZONE, t ?? 0);
  const hh = String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0");
  const mm = String(l.minuteOfDay % 60).padStart(2, "0");
  return `${l.date} ${hh}:${mm}`;
};

describe("one-off link expiry", () => {
  it("is 30 local days later when Berlin is already on the next day and DST ends in between (22:30 UTC)", () => {
    // 2026-10-20 00:30 CEST; summer time ends on 2026-10-25.
    const at = oneOffExpiry(link("2026-10-19T22:30:00.000Z"), 30, ZONE);
    expect(localOf(at)).toBe("2026-11-19 00:30");
  });

  it("is 30 local days later at 23:30 UTC", () => {
    const at = oneOffExpiry(link("2026-10-19T23:30:00.000Z"), 30, ZONE);
    expect(localOf(at)).toBe("2026-11-19 01:30");
  });

  it("is 30 local days later when DST starts in between (22:30 UTC, 23:30 CET)", () => {
    // 2027-03-01 23:30 CET; summer time starts on 2027-03-28.
    const at = oneOffExpiry(link("2027-03-01T22:30:00.000Z"), 30, ZONE);
    expect(localOf(at)).toBe("2027-03-31 23:30");
  });

  it("is 30 local days later from the second pass of the repeated hour (fall back)", () => {
    // 2026-10-25 02:30 CET, the second 02:30 of that day; 30 days later is 2026-11-24 02:30 CET.
    const at = oneOffExpiry(link("2026-10-25T01:30:00.000Z"), 30, ZONE);
    expect(at).toBe(Date.parse("2026-11-24T01:30:00.000Z"));
    expect(localOf(at)).toBe("2026-11-24 02:30");
  });

  it("keeps the seconds of the creation time", () => {
    const at = oneOffExpiry(link("2026-06-01T10:00:42.500Z"), 30, ZONE);
    expect(at).toBe(Date.parse("2026-07-01T10:00:42.500Z"));
  });

  it("is the creation time for a lifetime of 0 days", () => {
    expect(oneOffExpiry(link("2026-10-19T22:30:00.000Z"), 0, ZONE)).toBe(
      Date.parse("2026-10-19T22:30:00.000Z"),
    );
  });

  it("is null for a source link", () => {
    expect(oneOffExpiry(link("2026-10-19T22:30:00.000Z", null), 30, ZONE)).toBeNull();
  });
});
