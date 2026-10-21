// A new task chunk never takes the key of an ended chunk
// (planning-task-progress.md PRG-1, PRG-2): the ended chunk is done work, and
// the push step would write the new chunk over its record.
import { describe, expect, it } from "vitest";
import type { Snapshot, TaskItem } from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import {
  doneMinutes,
  endedUnstarted,
  type ProgressRow,
} from "../../src/server/planner/progress.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const now = localToUtc(ZONE, "2026-11-10", 12 * 60);
const always = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [[0, 1440]]]));

const snapshot = (t: Partial<TaskItem>): Snapshot => ({
  now,
  zone: ZONE,
  weekStart: 1,
  windowEnd: now + 7 * 86_400_000,
  stepMinutes: 15,
  urgencyMode: "priority-only",
  chunkCooldown: "none",
  breakMinutes: 0,
  hours: { always } as Snapshot["hours"],
  workHours: ["always"],
  events: [],
  current: [],
  tasks: [
    {
      id: "t",
      title: "t",
      level: 2,
      remainingMinutes: 20,
      minChunkMinutes: 30,
      maxChunkMinutes: 30,
      startAfter: now,
      dueAt: null,
      hours: "always",
      nextUpRank: null,
      createdAt: 0,
      exclusions: [],
      changed: false,
      ...t,
    },
  ],
  habits: [],
  meetings: [],
  buffers: [],
  focus: [],
});

describe("chunk keys after ended chunks", () => {
  it("starts new keys at nextIndex", () => {
    const keys = plan(snapshot({ nextIndex: 1 })).placements.map((p) => p.key);
    expect(keys).toEqual(["task:t:1"]);
  });
  it("starts at 0 without ended chunks", () => {
    expect(plan(snapshot({})).placements.map((p) => p.key)).toEqual(["task:t:0"]);
  });
});

describe("done work in manual start mode", () => {
  const manual = { startMode: "manual" as const, manualSince: now - 86_400_000 };
  const row = (o: Partial<ProgressRow>): ProgressRow => ({
    kind: "task",
    source_id: "t",
    start_ms: now - 3_600_000,
    end_ms: now - 1_800_000,
    event_id: "e",
    started: 0,
    ...o,
  });
  it("counts an ended chunk only when it was started; a lock alone does not start it", () => {
    expect(doneMinutes([row({})], now, manual).get("t")).toBeUndefined();
    expect(doneMinutes([row({ started: 1 })], now, manual).get("t")).toBe(30);
    expect(endedUnstarted(row({ started: 1 }), now, manual)).toBe(false);
  });
  it("counts every ended chunk in auto mode and chunks from before manual mode began", () => {
    expect(doneMinutes([row({})], now, { startMode: "auto", manualSince: null }).get("t")).toBe(30);
    expect(doneMinutes([row({})], now, { ...manual, manualSince: now }).get("t")).toBe(30);
  });
  it("does not count a running chunk", () => {
    expect(
      doneMinutes([row({ started: 1, end_ms: now + 1 })], now, manual).get("t"),
    ).toBeUndefined();
  });
});
