// Planned versus actual time (docs/specs/analytics-personal-stats.md rule 16,
// proposed): planned is the managed event time on the calendar at the start of
// the day, read from Tempoloom's change log; actual is the managed event time
// left on the calendar at the end of the day. An E2E run cannot pass a day
// boundary, so these cases run here. Failure modes:
// 1. Planned time reads the calendar now instead of at the start of each day.
// 2. A move during the day changes planned time, or loses actual time.
// 3. An event removed during the day still counts as actual time.
// 4. An event placed during the day counts as planned time.
// 5. A day that has not ended yet is reported.
// 6. Day boundaries use UTC instead of the user's zone.
import { describe, expect, it } from "vitest";
import { plannedVersusActual } from "../../src/server/analytics/planned.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const TUE = "2026-11-10";
const t = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};

describe("planned versus actual", () => {
  it("compares the calendar at the start of each ended day with the calendar at its end", () => {
    const r = plannedVersusActual({
      zone: ZONE,
      from: MON,
      to: TUE,
      now: t(TUE, "12:00"),
      entries: [
        // Placed the evening before: planned. Moved during the day: still planned at 60 minutes.
        {
          key: "task:a:0",
          item: "task:a",
          action: "create",
          start: t(MON, "09:00"),
          end: t(MON, "10:00"),
          at: t("2026-11-08", "20:00"),
        },
        {
          key: "task:a:0",
          item: "task:a",
          action: "update",
          start: t(MON, "14:00"),
          end: t(MON, "15:00"),
          at: t(MON, "08:00"),
        },
        // Planned, then removed during the day: planned, not actual.
        {
          key: "habit:h:x",
          item: "habit:h",
          action: "create",
          start: t(MON, "12:00"),
          end: t(MON, "12:30"),
          at: t("2026-11-08", "20:00"),
        },
        {
          key: "habit:h:x",
          item: "habit:h",
          action: "delete",
          start: t(MON, "12:00"),
          end: t(MON, "12:30"),
          at: t(MON, "11:00"),
        },
        // Placed during the day: actual, not planned.
        {
          key: "focus:f:1",
          item: "focus:f",
          action: "create",
          start: t(MON, "16:00"),
          end: t(MON, "17:00"),
          at: t(MON, "07:00"),
        },
        // Tuesday has not ended: not reported.
        {
          key: "task:a:1",
          item: "task:a",
          action: "create",
          start: t(TUE, "09:00"),
          end: t(TUE, "10:00"),
          at: t(MON, "20:00"),
        },
        // Copies are not planned work.
        {
          key: "mirror:p:e",
          item: "mirror:p",
          action: "create",
          start: t(MON, "10:00"),
          end: t(MON, "11:00"),
          at: t("2026-11-08", "20:00"),
        },
      ],
      current: [
        { kind: "task", start: t(MON, "14:00"), end: t(MON, "15:00") },
        { kind: "focus", start: t(MON, "16:00"), end: t(MON, "17:00") },
        { kind: "task", start: t(TUE, "09:00"), end: t(TUE, "10:00") },
      ],
    });
    expect(r.days).toBe(1);
    expect(r.byKind).toEqual({
      task: { planned: 60, actual: 60 },
      habit: { planned: 30, actual: 0 },
      focus: { planned: 0, actual: 60 },
    });
  });

  it("uses the user's zone for day boundaries", () => {
    // 23:30 to 00:30 Berlin time: 30 minutes on each local day.
    const r = plannedVersusActual({
      zone: ZONE,
      from: MON,
      to: MON,
      now: t(TUE, "12:00"),
      entries: [
        {
          key: "task:b:0",
          item: "task:b",
          action: "create",
          start: t(MON, "23:30"),
          end: t(TUE, "00:30"),
          at: t("2026-11-08", "12:00"),
        },
      ],
      current: [{ kind: "task", start: t(MON, "23:30"), end: t(TUE, "00:30") }],
    });
    expect(r.byKind).toEqual({ task: { planned: 30, actual: 30 } });
  });
});
