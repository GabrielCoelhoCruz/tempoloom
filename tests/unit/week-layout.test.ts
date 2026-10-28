// The planner's overlap layout (docs/specs/ui-refresh.md LAY-40 to LAY-45): a
// cluster shows at most `cap` columns, and the other events fold into "+N".
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LocalDate } from "../../src/shared/time.ts";
import { localToUtc } from "../../src/shared/time.ts";
import type { WeekEvent } from "../../src/web/views/week.tsx";

const ZONE = "Europe/Berlin";
const DAY = "2026-11-03" as LocalDate;
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return localToUtc(ZONE, DAY, (h ?? 0) * 60 + (m ?? 0));
};
const ev = (id: string, from: string, to: string): WeekEvent => ({
  id,
  start: at(from),
  end: at(to),
  title: id,
  kind: "external",
  busy: true,
  locked: true,
  movable: false,
});

let layout: typeof import("../../src/web/views/week.tsx").layout;
beforeAll(async () => {
  // week.tsx reads the viewport width through matchMedia when it loads.
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {} }));
  ({ layout } = await import("../../src/web/views/week.tsx"));
});

const run = (events: WeekEvent[], cap?: number) => {
  const { boxes, more } = layout([DAY], ZONE, events, cap);
  return {
    shown: boxes.map((b) => `${b.ev.id}@${b.col}/${b.cols}${b.lane ? "+lane" : ""}`),
    more: more.map((m) => ({ top: m.top, ids: m.events.map((e) => e.id) })),
  };
};

describe("week layout", () => {
  it("puts 2 overlapping events side by side with no lane", () => {
    expect(run([ev("a", "10:00", "11:00"), ev("b", "10:30", "11:30")], 3)).toEqual({
      shown: ["a@0/2", "b@1/2"],
      more: [],
    });
  });

  it("shows 3 overlapping events in 3 columns with cap 3", () => {
    const three = [ev("a", "10:00", "11:00"), ev("b", "10:00", "11:00"), ev("c", "10:30", "11:30")];
    expect(run(three, 3)).toEqual({ shown: ["a@0/3", "b@1/3", "c@2/3"], more: [] });
  });

  it("folds the third column of 3 overlapping events with cap 2", () => {
    const three = [ev("a", "10:00", "11:00"), ev("b", "10:00", "11:00"), ev("c", "10:30", "11:30")];
    expect(run(three, 2)).toEqual({
      shown: ["a@0/2+lane", "b@1/2+lane"],
      more: [{ top: 10.5 * 48, ids: ["c"] }],
    });
  });

  it("folds 8 events in one slot into one '+N' button with the count of the folded ones", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ev(`e${i}`, "09:00", "10:00"));
    for (const [cap, n] of [
      [3, 5],
      [2, 6],
    ] as const) {
      const r = run(eight, cap);
      expect(r.shown).toHaveLength(cap);
      expect(r.shown.every((s) => s.endsWith(`/${cap}+lane`))).toBe(true);
      expect(r.more).toEqual([{ top: 9 * 48, ids: eight.slice(cap).map((e) => e.id) }]);
      expect(r.more[0]?.ids).toHaveLength(n);
    }
  });

  it("ends a cluster when a chain of overlaps ends, so the next cluster starts with its own columns", () => {
    const events = [
      ev("a", "08:00", "09:00"),
      ev("b", "08:30", "09:30"),
      ev("c", "09:00", "10:00"), // overlaps b: the chain goes on, and c takes a's free column
      ev("d", "09:15", "09:45"), // a third column in the same cluster: it folds with cap 2
      ev("e", "11:00", "12:00"), // after the chain: a new cluster of its own
    ];
    expect(run(events, 2)).toEqual({
      shown: ["a@0/2+lane", "b@1/2+lane", "c@0/2+lane", "e@0/1"],
      more: [{ top: 9.25 * 48, ids: ["d"] }],
    });
    expect(run(events).shown).toEqual(["a@0/3", "b@1/3", "c@0/3", "d@2/3", "e@0/1"]);
  });

  it("counts the folded events of each cluster on its own", () => {
    const events = [
      ev("a", "08:00", "09:00"),
      ev("b", "08:00", "09:00"),
      ev("c", "08:00", "09:00"),
      ev("d", "14:00", "15:00"),
      ev("e", "14:00", "15:00"),
      ev("f", "14:00", "15:00"),
      ev("g", "14:00", "15:00"),
    ];
    expect(run(events, 2).more).toEqual([
      { top: 8 * 48, ids: ["c"] },
      { top: 14 * 48, ids: ["f", "g"] },
    ]);
  });
});
