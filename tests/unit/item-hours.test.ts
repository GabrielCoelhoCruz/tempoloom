// Item-specific hours in one-range forms (docs/specs/planning-hours.md).
// Ways it can fail:
// 1. Saving a form that shows one range replaces stored hours of several ranges.
// 2. A change of the shown range is lost.
// 3. Midnight as the end of a range reads back as 00:00 and saves as 0.
import { describe, expect, it } from "vitest";
import {
  changedHours,
  fitsOneRange,
  itemHoursOf,
  itemRangeOf,
  type Weekly,
} from "../../src/shared/item-hours.ts";

const split: Weekly = {
  "1": [
    [540, 600],
    [780, 840],
  ],
  "3": [[600, 720]],
};

describe("item-specific hours in a one-range form", () => {
  it("keeps stored hours of several ranges when the shown range is unchanged", () => {
    expect(fitsOneRange(split)).toBe(false);
    const shown = itemHoursOf(itemRangeOf(split));
    expect(shown).toEqual({ "1": [[540, 600]], "3": [[540, 600]] });
    expect(changedHours(split, shown)).toBeUndefined();
  });

  it("saves the form's range once the user changes it", () => {
    const next = itemHoursOf({ days: [1, 3], from: "08:00", to: "10:00" });
    expect(changedHours(split, next)).toEqual(next);
    expect(changedHours(null, next)).toEqual(next);
  });

  it("reads and writes a range to midnight", () => {
    const late: Weekly = { "5": [[1200, 1440]] };
    expect(itemRangeOf(late)).toEqual({ days: [5], from: "20:00", to: "00:00" });
    expect(itemHoursOf(itemRangeOf(late))).toEqual(late);
    expect(fitsOneRange(late)).toBe(true);
  });
});
