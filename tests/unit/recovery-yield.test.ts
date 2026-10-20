// A recovery buffer gives way to a habit at its last slot
// (docs/specs/buffers-automation.md rule 18). The E2E test covers the journey;
// these cover the cases a week of E2E data does not reach.
// Failure modes, each covered below:
//  1. The buffer yields while the habit still has room on another allowed day.
//  2. A before buffer (prep) or travel time yields too.
//  3. A locked buffer yields.
//  4. The freed time is not given back, so a later item cannot use what the habit left.
import { describe, expect, it } from "vitest";
import type {
  BufferItem,
  CurrentPlacement,
  ExternalEvent,
  HabitItem,
  Placement,
  Snapshot,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-02";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const hm = (t: number) =>
  new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(0, 16).replace(" ", "T");
const spans = (ps: Placement[]) => ps.map((p) => `${hm(p.start)}/${hm(p.end).slice(11)}`);
const thisWeek = (ps: Placement[]) => ps.filter((p) => p.start < at(addDays(MON, 7), "00:00"));
const of = (r: ReturnType<typeof plan>, id: string) =>
  thisWeek(r.placements.filter((p) => p.itemId === id));

const WORK = {
  1: [[540, 1020]],
  2: [[540, 1020]],
  3: [[540, 1020]],
  4: [[540, 1020]],
  5: [[540, 1020]],
} as const;

let seq = 0;
const ext = (
  date: string,
  a: string,
  b: string,
  over: Partial<ExternalEvent> = {},
): ExternalEvent => ({
  id: `ext-${++seq}`,
  start: at(date, a),
  end: at(date, b),
  allDay: false,
  busy: true,
  title: "Event",
  description: "",
  selfResponse: null,
  organizerSelf: true,
  attendeeCount: 0,
  location: "",
  eventType: "default",
  bookedViaLink: false,
  ...over,
});
const meeting = (date: string, a: string, b: string) =>
  ext(date, a, b, { attendeeCount: 2, attendees: ["me@x.test", "a@corp.example"] });

const habit: HabitItem = {
  id: "walk",
  title: "Walk",
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  idealMinute: 720,
  minMinutes: 30,
  maxMinutes: 30,
  frequency: { period: "weekly", days: [1] },
  starting: null,
  defense: "adaptive",
  whenUnplaceable: "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
};

const buffer = (over: Partial<BufferItem> = {}): BufferItem => ({
  id: "rec",
  title: "Recovery",
  level: 1,
  rank: 0,
  createdAt: 0,
  side: "after",
  minutesBefore: 15,
  minutesAfter: 15,
  busy: true,
  filter: { participants: { op: ">=", value: 2 } },
  onConflict: "remove",
  changed: false,
  ...over,
});

/** Monday: free only 12:00-12:30 after an 11:00 meeting; `freeDay` opens one more day. */
function snapshot(over: Partial<Snapshot> = {}, freeDay?: number): Snapshot {
  const busyDays = [1, 2, 3, 4].filter((n) => n !== freeDay);
  return {
    now: at(addDays(MON, -3), "08:00"),
    zone: ZONE,
    weekStart: 1,
    windowEnd: at(addDays(MON, 7), "00:00"),
    stepMinutes: 15,
    urgencyMode: "priority-only",
    chunkCooldown: "none",
    breakMinutes: 0,
    hours: { work: WORK },
    workHours: ["work"],
    events: [
      ext(MON, "09:00", "11:00"),
      meeting(MON, "11:00", "12:00"),
      ext(MON, "12:30", "17:00"),
      ...busyDays.map((n) => ext(addDays(MON, n), "09:00", "17:00")),
    ],
    current: [],
    tasks: [],
    habits: [habit],
    meetings: [],
    buffers: [buffer()],
    focus: [],
    ...over,
  };
}

describe("recovery buffer and a habit at its last slot (buffers rule 18)", () => {
  it("removes the recovery buffer and places the habit there, busy", () => {
    const r = plan(snapshot());
    expect(spans(of(r, "rec"))).toEqual([]);
    expect(spans(of(r, "walk"))).toEqual([`${MON}T12:00/12:30`]);
    expect(of(r, "walk")[0]?.busy).toBe(true);
  });

  it("keeps the buffer when the habit has room on another day of the week", () => {
    const r = plan(snapshot({}, 2));
    expect(spans(of(r, "rec"))).toEqual([`${MON}T12:00/12:15`]);
    expect(of(r, "walk")).toHaveLength(1);
    expect(of(r, "walk")[0]?.start).toBeGreaterThanOrEqual(at(addDays(MON, 2), "00:00"));
  });

  it("does not take a prep buffer or travel time", () => {
    // A prep buffer before a 12:30 meeting holds 12:15-12:30.
    const prep = snapshot({
      buffers: [buffer({ side: "before" })],
      events: [
        ext(MON, "09:00", "12:00"),
        meeting(MON, "12:30", "17:00"),
        ...[1, 2, 3, 4].map((n) => ext(addDays(MON, n), "09:00", "17:00")),
      ],
    });
    const r1 = plan(prep);
    expect(spans(of(r1, "rec"))).toEqual([`${MON}T12:15/12:30`]);
    expect(of(r1, "walk")).toEqual([]);
    const travel = snapshot({
      buffers: [buffer({ filter: { travel: true } })],
      events: [
        ext(MON, "09:00", "11:00"),
        ext(MON, "11:00", "12:00", { location: "1 Oak Ave, Springfield, IL 62701" }),
        ext(MON, "12:30", "17:00"),
        ...[1, 2, 3, 4].map((n) => ext(addDays(MON, n), "09:00", "17:00")),
      ],
    });
    const r2 = plan(travel);
    expect(spans(of(r2, "rec"))).toEqual([`${MON}T12:00/12:15`]);
    expect(of(r2, "walk")).toEqual([]);
  });

  it("does not take a locked buffer", () => {
    const locked: CurrentPlacement = {
      key: "buffer:rec:ext-locked:after",
      itemId: "rec",
      start: at(MON, "12:00"),
      end: at(MON, "12:15"),
      locked: true,
    };
    const r = plan(
      snapshot({ buffers: [buffer({ filter: { exactTitle: "none" } })], current: [locked] }),
    );
    expect(spans(of(r, "rec"))).toEqual([`${MON}T12:00/12:15`]);
    expect(of(r, "walk")).toEqual([]);
  });
});
