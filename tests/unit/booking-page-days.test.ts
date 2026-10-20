// The booking page and the link inspector show times two weeks per page
// (booking-links-booking-page.md). A page is 14 local days in the selected
// zone. Ways it can fail: a page of 14 x 24 hours ends at 01:00 or 23:00 after
// a DST change, so a day shows on two pages or its last hour is lost.
import { describe, expect, it } from "vitest";
import { localToUtc } from "../../src/shared/time.ts";
import { addPages } from "../../src/web/lib/zoned.ts";

describe("booking page span", () => {
  it.each([
    ["America/New_York", "2026-03-01", "2026-03-15"],
    ["America/New_York", "2026-10-25", "2026-11-08"],
    ["Europe/Lisbon", "2026-03-23", "2026-04-06"],
    ["Europe/Lisbon", "2026-10-19", "2026-11-02"],
  ])("in %s a page from %s ends at local midnight of %s", (zone, from, to) => {
    const view = { zone, format: "24" as const };
    const start = localToUtc(zone, from, 0);
    expect(addPages(view, start, 1)).toBe(localToUtc(zone, to, 0));
    expect(addPages(view, localToUtc(zone, to, 0), -1)).toBe(start);
  });
});
