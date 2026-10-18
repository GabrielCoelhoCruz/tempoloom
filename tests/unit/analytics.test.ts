// Failure modes of the per-member figures and the group metrics
// (docs/specs/analytics-personal-stats.md, analytics-team-stats.md,
// analytics-organization.md rules 2-7):
// 1. Overlapping events count a minute twice, or in the wrong category
//    (edge case 3: the event that started first wins; on a tie, the longer).
// 2. Touching solo events are two sessions; a 120-minute session is shallow;
//    solo events with a gap merge into one session.
// 3. Day boundaries use UTC or the viewer's zone instead of the member's.
// 4. Free time counts time outside work hours, or ignores events in it.
// 5. Meetings outside work hours are not counted apart.
// 6. Fragmented time counts gaps at the start or end of the work day.
// 7. Free blocks of exactly 2 hours do not count as long blocks.
// 8. Vacation counts 24 hours a day instead of the work day.
// 9. The deep work score does not follow the proposed formula.
// 10. The time-in-meetings distribution counts hours instead of members.
import { describe, expect, it } from "vitest";
import { type Day, memberDays, type Span } from "../../src/server/analytics/member.ts";
import { deepWorkScore, distribution, groupMetrics } from "../../src/server/analytics/metrics.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const NINE_TO_FIVE = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [[540, 1020]]]));
const t = (date: string, hhmm: string, zone = ZONE) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(zone, date, h * 60 + m);
};
const span = (kind: Span["kind"], from: string, to: string, date = MON): Span => ({
  kind,
  start: t(date, from),
  end: t(date, to),
});
const oneDay = (spans: Span[]) => memberDays(spans, ZONE, NINE_TO_FIVE, MON, MON)[0] as Day;

describe("memberDays", () => {
  it("counts each minute once, in the category of the event that started first (1)", () => {
    const d = oneDay([span("externalMeetings", "10:00", "11:00"), span("solo", "10:30", "12:00")]);
    expect(d.minutes.externalMeetings).toBe(60);
    expect(d.minutes.shallowWork).toBe(60);
    const tie = oneDay([
      span("oneOnOne", "10:00", "10:30"),
      span("teamMeetings", "10:00", "11:00"),
    ]);
    expect(tie.minutes.teamMeetings).toBe(60);
    expect(tie.minutes.oneOnOne).toBe(0);
  });

  it("joins touching solo events into one session; 120 minutes is deep work (2)", () => {
    const d = oneDay([span("solo", "09:00", "10:00"), span("solo", "10:00", "11:00")]);
    expect(d.minutes.deepWork).toBe(120);
    expect(d.sessions).toEqual([120]);
    const apart = oneDay([span("solo", "09:00", "10:00"), span("solo", "10:30", "11:30")]);
    expect(apart.minutes.shallowWork).toBe(120);
    expect(apart.sessions).toEqual([60, 60]);
  });

  it("puts an event on the member's own local date (3)", () => {
    const ny = "America/New_York";
    const late = {
      kind: "externalMeetings" as const,
      start: t(MON, "23:00", ny),
      end: t("2026-11-10", "00:00", ny),
    };
    const days = memberDays([late], ny, NINE_TO_FIVE, MON, "2026-11-10");
    expect(days.map((d) => [d.date, d.minutes.externalMeetings, d.meetingsOutsideWork])).toEqual([
      [MON, 60, 60],
      ["2026-11-10", 0, 0],
    ]);
  });

  it("measures free time inside work hours only, and meetings outside them apart (4, 5)", () => {
    const d = oneDay([span("teamMeetings", "08:00", "10:00"), span("travel", "18:00", "19:00")]);
    expect(d.work).toBe(480);
    expect(d.minutes.free).toBe(420);
    expect(d.meetingsOutsideWork).toBe(60);
    expect(d.minutes.travel).toBe(60);
  });

  it("counts fragmented time only between events, and 2-hour free blocks as long (6, 7)", () => {
    const d = oneDay([span("oneOnOne", "09:30", "10:00"), span("oneOnOne", "10:30", "13:00")]);
    // Free: 09:00-09:30 (start of day), 10:00-10:30 (between events), 13:00-17:00.
    expect(d.fragmented).toBe(30);
    expect(d.minutes.free).toBe(300);
    expect(d.freeInLongBlocks).toBe(240);
    const exact = oneDay([span("oneOnOne", "11:00", "15:00")]);
    expect(exact.freeInLongBlocks).toBe(240);
  });

  it("counts vacation inside work hours only (8)", () => {
    const d = oneDay([{ kind: "vacation", start: t(MON, "00:00"), end: t("2026-11-10", "00:00") }]);
    expect(d.minutes.vacation).toBe(480);
    expect(d.minutes.free).toBe(0);
  });
});

describe("group metrics", () => {
  it("scores deep work with the proposed formula (9)", () => {
    // One person, one day: 2 h of meetings, free 09:00-10:00 (fragment-free start), 11:00-11:30
    // between meetings, 12:00-17:00.
    const d = oneDay([
      span("teamMeetings", "10:00", "11:00"),
      span("teamMeetings", "11:30", "12:00"),
    ]);
    // a = 1 - 90/480; b = 1; c = 300/390; d = 1 - 30/390.
    const expected = Math.round(25 * (1 - 90 / 480 + 1 + 300 / 390 + (1 - 30 / 390)));
    expect(deepWorkScore([[d]])).toBe(expected);
    const heavy = oneDay([span("teamMeetings", "09:00", "13:00")]);
    // a = 0.5; b = 0 (4 h is not less than 4 h); c = 1; d = 1.
    expect(deepWorkScore([[heavy]])).toBe(63);
  });

  it("gives the percent of members who reach each threshold (10)", () => {
    const week = (hours: number) =>
      memberDays(
        hours
          ? [span("externalMeetings", "09:00", `${String(9 + hours).padStart(2, "0")}:00`)]
          : [],
        ZONE,
        NINE_TO_FIVE,
        MON,
        "2026-11-15",
      );
    const out = distribution([week(8), week(5), week(1)], "week");
    expect(out.thresholds).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(out.percent).toEqual([100, 67, 0, 0, 0, 0, 0]);
  });

  it("averages per person and per week, and costs meetings at each person's rate", () => {
    const a = memberDays(
      [span("externalMeetings", "09:00", "12:00")],
      ZONE,
      NINE_TO_FIVE,
      MON,
      "2026-11-15",
    );
    const b = memberDays(
      [span("oneOnOne", "09:00", "10:00")],
      ZONE,
      NINE_TO_FIVE,
      MON,
      "2026-11-15",
    );
    const m = groupMetrics([
      { days: a, hourly: 100 },
      { days: b, hourly: 50 },
    ]);
    expect(m.meetings).toBe(120);
    expect(m.dailyMeetingLoad).toBe(24);
    expect(m.cost).toBe(350);
  });
});
