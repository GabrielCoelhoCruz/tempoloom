// Fragmented time (docs/specs/teams-policies.md rule 21, analytics-organization.md
// rule 4): inside each work-hours range, the sum of the gaps between busy events
// that are shorter than the minimum usable block.
import { type Interval, TimeSet } from "../../scheduler/timeset.ts";

/** Minutes of fragmented time. `workRanges` are the contiguous work-hours ranges. */
export function fragmentedMinutes(
  busy: Interval[],
  workRanges: Interval[],
  minBlockMinutes: number,
): number {
  const merged = TimeSet.from(busy);
  let total = 0;
  for (const range of workRanges) {
    const inside = merged.clone().clip(range.start, range.end).intervals();
    for (let i = 1; i < inside.length; i++) {
      const gap = (inside[i]?.start ?? 0) - (inside[i - 1]?.end ?? 0);
      if (gap > 0 && gap < minBlockMinutes * 60_000) total += gap;
    }
  }
  return total / 60_000;
}
