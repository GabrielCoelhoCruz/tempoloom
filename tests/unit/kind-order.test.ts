// The scheduler's kind order inside one level and rank comes from
// AUTOMATION_TYPES (src/shared/automation-types.ts), the list the automation
// page sorts by, so the two orders cannot drift.
//
// Way it can fail:
// 1. plan.ts keeps its own copy of the order: a change to AUTOMATION_TYPES
//    reorders the list but not the plan.
import { describe, expect, it, vi } from "vitest";
import type { HabitItem, MeetingItem, Snapshot } from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { localToUtc } from "../../src/shared/time.ts";

// The list order with habits first: if the plan follows the list, a habit now
// wins a tie with a meeting.
vi.mock("../../src/shared/automation-types.ts", () => ({
  AUTOMATION_TYPES: [
    "habit",
    "buffer",
    "flexible_meeting",
    "meeting_overload",
    "focus_time",
    "meeting_check",
  ],
}));

const ZONE = "UTC";
const MON = "2026-11-02";
const WORK = { 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]] } as const;

const habit: HabitItem = {
  id: "habit",
  title: "habit",
  level: 2,
  rank: 0,
  createdAt: 0,
  hours: "work",
  idealMinute: 600,
  minMinutes: 30,
  maxMinutes: 30,
  frequency: { period: "weekly", days: [2] },
  starting: null,
  defense: "always-busy",
  whenUnplaceable: "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
};

const meeting: MeetingItem = {
  id: "meeting",
  title: "meeting",
  level: 2,
  rank: 0,
  createdAt: 0,
  hours: "work",
  attendeeWindow: null,
  attendeeBusy: [],
  idealMinute: 600,
  frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
  durationMinutes: 30,
  shortestMinutes: 30,
  starting: MON,
  defense: "busy",
  whenUnplaceable: "remove",
  leadMinutes: 0,
  exclusions: [],
  changed: false,
};

const snapshot: Snapshot = {
  now: localToUtc(ZONE, MON, 6 * 60),
  zone: ZONE,
  weekStart: 1,
  windowEnd: localToUtc(ZONE, "2026-11-09", 0),
  stepMinutes: 15,
  urgencyMode: "priority-only",
  chunkCooldown: "none",
  breakMinutes: 0,
  hours: { work: WORK },
  workHours: ["work"],
  events: [],
  current: [],
  tasks: [],
  habits: [habit],
  meetings: [meeting],
  buffers: [],
  focus: [],
};

describe("kind order in the plan", () => {
  it("follows AUTOMATION_TYPES: at one level and rank the first type wins the ideal slot", () => {
    const result = plan(snapshot);
    const tue10 = localToUtc(ZONE, "2026-11-03", 600);
    const start = (id: string) => result.placements.find((p) => p.itemId === id)?.start;
    expect(start("habit")).toBe(tue10);
    expect(start("meeting")).not.toBe(tue10);
  });
});
