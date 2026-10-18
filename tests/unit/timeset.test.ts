// Failure modes of the free-time set:
// 1. Overlapping, touching or unsorted input must normalize to disjoint sorted intervals.
// 2. Empty or inverted intervals must be ignored, not stored.
// 3. Subtracting must split an interval that contains the removed range.
// 4. Subtracting a range that covers several intervals must remove all of them.
// 5. Candidate starts must align to a fixed grid, not to each interval's start.
// 6. A candidate must fit entirely inside one free interval.
// 7. Intersection must keep only time present in both sets.
// 8. Random operation sequences must agree with a minute-by-minute model.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TimeSet } from "../../src/scheduler/timeset.ts";

const M = 60_000;
const iv = (a: number, b: number) => ({ start: a * M, end: b * M });
const mins = (s: TimeSet) => s.intervals().map((i) => [i.start / M, i.end / M]);

describe("TimeSet", () => {
  it("normalizes overlapping, touching and unsorted intervals", () => {
    const s = TimeSet.from([iv(30, 40), iv(0, 10), iv(10, 20), iv(15, 25), iv(50, 50), iv(70, 60)]);
    expect(mins(s)).toEqual([
      [0, 25],
      [30, 40],
    ]);
    expect(s.total()).toBe(35 * M);
  });

  it("splits an interval when a middle part is removed", () => {
    const s = TimeSet.from([iv(0, 60)]);
    s.subtract(iv(20, 30));
    expect(mins(s)).toEqual([
      [0, 20],
      [30, 60],
    ]);
  });

  it("removes every interval covered by a subtracted range", () => {
    const s = TimeSet.from([iv(0, 10), iv(20, 30), iv(40, 50), iv(60, 70)]);
    s.subtract(iv(5, 65));
    expect(mins(s)).toEqual([
      [0, 5],
      [65, 70],
    ]);
  });

  it("aligns candidate starts to the grid", () => {
    const s = TimeSet.from([iv(7, 100)]);
    const starts = [...s.candidates(30 * M, 15 * M)].map((t) => t / M);
    expect(starts).toEqual([15, 30, 45, 60]);
  });

  it("only offers candidates that fit inside one interval", () => {
    const s = TimeSet.from([iv(0, 20), iv(20, 25), iv(30, 60)]);
    const starts = [...s.candidates(30 * M, 15 * M)].map((t) => t / M);
    expect(starts).toEqual([30]);
    expect(s.contains(iv(0, 25))).toBe(true);
    expect(s.contains(iv(20, 35))).toBe(false);
  });

  it("intersects two sets", () => {
    const a = TimeSet.from([iv(0, 30), iv(40, 90)]);
    const b = TimeSet.from([iv(20, 50), iv(80, 100)]);
    expect(mins(a.intersect(b))).toEqual([
      [20, 30],
      [40, 50],
      [80, 90],
    ]);
  });

  it("matches a minute-by-minute model for random operations", () => {
    const span = fc.tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 40 }));
    fc.assert(
      fc.property(
        fc.array(span, { maxLength: 12 }),
        fc.array(span, { maxLength: 12 }),
        (adds, subs) => {
          const model = new Array<boolean>(260).fill(false);
          for (const [a, len] of adds) for (let m = a; m < a + len; m++) model[m] = true;
          for (const [a, len] of subs) for (let m = a; m < a + len; m++) model[m] = false;
          const s = TimeSet.from(adds.map(([a, len]) => iv(a, a + len)));
          for (const [a, len] of subs) s.subtract(iv(a, a + len));
          const fromModel: number[][] = [];
          for (let m = 0; m < model.length; m++) {
            if (!model[m]) continue;
            const last = fromModel.at(-1);
            if (last && last[1] === m) last[1] = m + 1;
            else fromModel.push([m, m + 1]);
          }
          expect(mins(s)).toEqual(fromModel);
        },
      ),
    );
  });
});
