// The scheduler preference of a fragmentation policy (docs/specs/teams-policies.md
// rules 6, 23). Failure modes:
// 1. With the preference, a habit still leaves a short gap next to a meeting.
// 2. The habit moves further from its ideal time than the member's flexibility.
// 3. A smaller move that only shrinks the gap is not taken when the full one is too far.
// 4. Without the preference, placement changes (it must stay nearest the ideal time).
// 5. A gap at the edge of work hours counts as fragmented (it is not between busy events).
// 6. A flexible meeting ignores the preference.
// 7. An existing placement moves when the preference starts (rule 6).
import { describe, expect, it } from "vitest";
import type {
  ExternalEvent,
  HabitItem,
  MeetingItem,
  Placement,
  Snapshot,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const TUE = addDays(MON, 1);
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const hm = (t: number) => new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(11, 16);
const WORK = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [[540, 1020]]]));

function meeting(start: string, end: string): ExternalEvent {
  return {
    id: `ev-${start}`,
    start: at(TUE, start),
    end: at(TUE, end),
    allDay: false,
    busy: true,
    title: "Standup",
    description: "",
    selfResponse: null,
    organizerSelf: true,
    attendeeCount: 0,
    location: "",
    eventType: "default",
    bookedViaLink: false,
  };
}

function habit(ideal: string): HabitItem {
  const [h, m] = ideal.split(":").map(Number) as [number, number];
  return {
    id: "review",
    title: "Review",
    level: 3,
    rank: 0,
    createdAt: 0,
    hours: "work",
    idealMinute: h * 60 + m,
    minMinutes: 30,
    maxMinutes: 30,
    frequency: { period: "weekly", days: [2] },
    starting: null,
    defense: "adaptive",
    whenUnplaceable: "remove",
    reservedWords: [],
    skips: [],
    exclusions: [],
    changed: false,
  };
}

function snapshot(over: Partial<Snapshot>): Snapshot {
  return {
    now: at(addDays(MON, -1), "12:00"),
    zone: ZONE,
    weekStart: 1,
    windowEnd: at(addDays(MON, 6), "00:00"),
    stepMinutes: 15,
    urgencyMode: "priority-only",
    chunkCooldown: "none",
    breakMinutes: 0,
    hours: { work: WORK },
    workHours: ["work"],
    events: [meeting("09:00", "10:00")],
    current: [],
    tasks: [],
    habits: [],
    meetings: [],
    buffers: [],
    focus: [],
    ...over,
  };
}

const startOf = (placements: Placement[], kind: string) =>
  placements.filter((p) => p.kind === kind).map((p) => hm(p.start));

const pref = (maxShiftMinutes: number) => ({ minBlockMinutes: 60, maxShiftMinutes });

describe("fragmentation preference", () => {
  it("moves a habit next to a meeting instead of leaving a short gap", () => {
    const r = plan(snapshot({ habits: [habit("10:30")], fragmentation: pref(30) }));
    expect(startOf(r.placements, "habit")).toEqual(["10:00"]);
  });

  it("keeps the nearest ideal time without the preference", () => {
    const r = plan(snapshot({ habits: [habit("10:30")] }));
    expect(startOf(r.placements, "habit")).toEqual(["10:30"]);
  });

  it("never moves further than the flexibility; it shrinks the gap as far as allowed", () => {
    const r = plan(snapshot({ habits: [habit("10:30")], fragmentation: pref(15) }));
    expect(startOf(r.placements, "habit")).toEqual(["10:15"]);
  });

  it("stays at the ideal time when that leaves no fragmented gap", () => {
    // 11:00 leaves 10:00-11:00, a usable 60-minute block.
    const r = plan(snapshot({ habits: [habit("11:00")], fragmentation: pref(60) }));
    expect(startOf(r.placements, "habit")).toEqual(["11:00"]);
  });

  it("does not count time at the start of work hours as fragmented", () => {
    // No meeting: 09:15 would leave 09:00-09:15, which is not between busy events.
    const r = plan(snapshot({ events: [], habits: [habit("09:15")], fragmentation: pref(60) }));
    expect(startOf(r.placements, "habit")).toEqual(["09:15"]);
  });

  it("places a flexible meeting next to busy time", () => {
    const m: MeetingItem = {
      id: "sync",
      title: "Sync",
      level: 3,
      rank: 0,
      createdAt: 0,
      hours: "work",
      attendeeWindow: null,
      attendeeBusy: [],
      idealMinute: 10 * 60 + 30,
      frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
      durationMinutes: 30,
      shortestMinutes: 30,
      starting: null,
      defense: "busy",
      whenUnplaceable: "remove",
      leadMinutes: 0,
      exclusions: [],
      changed: false,
    };
    const without = plan(snapshot({ meetings: [m] }));
    expect(startOf(without.placements, "meeting")).toEqual(["10:30"]);
    const r = plan(snapshot({ meetings: [m], fragmentation: pref(30) }));
    expect(startOf(r.placements, "meeting")).toEqual(["10:00"]);
  });

  it("keeps an existing placement when the preference starts (rule 6)", () => {
    const key = `habit:review:${TUE}`;
    const r = plan(
      snapshot({
        habits: [habit("10:30")],
        fragmentation: pref(30),
        current: [
          {
            key,
            itemId: "review",
            start: at(TUE, "10:30"),
            end: at(TUE, "11:00"),
            locked: false,
          },
        ],
      }),
    );
    expect(startOf(r.placements, "habit")).toEqual(["10:30"]);
  });
});
