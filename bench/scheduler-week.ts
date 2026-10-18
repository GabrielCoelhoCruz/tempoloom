// Solver time for a realistic week: 50 tasks, 10 habits and 30 meetings over
// a 14-day window, plus 2 buffer automations and a focus goal.
// Usage: node bench/scheduler-week.ts [runs]
import { cpus } from "node:os";
import type { ExternalEvent, HabitItem, Snapshot, TaskItem } from "../src/scheduler/model.ts";
import { plan } from "../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const MIN = 60_000;
let seed = 42;
const rand = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
const weekdays = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];

const events: ExternalEvent[] = Array.from({ length: 30 }, (_, i) => {
  const date = addDays(MON, pick(weekdays));
  const start = localToUtc(ZONE, date, (9 + Math.floor(rand() * 8)) * 60 + pick([0, 30]));
  return {
    id: `m${i}`,
    start,
    end: start + pick([30, 45, 60, 90]) * MIN,
    allDay: false,
    busy: true,
    title: `Meeting ${i}`,
    description: "",
    selfResponse: "accepted",
    organizerSelf: false,
    attendeeCount: 2 + Math.floor(rand() * 5),
    location: "",
    eventType: "default",
    bookedViaLink: false,
  };
});

const tasks: TaskItem[] = Array.from({ length: 50 }, (_, i) => ({
  id: `t${i}`,
  title: `Task ${i}`,
  level: pick([1, 2, 2, 3, 3, 4] as const),
  remainingMinutes: pick([30, 45, 60, 90, 120]),
  minChunkMinutes: 30,
  maxChunkMinutes: 120,
  startAfter: localToUtc(ZONE, MON, 0),
  dueAt: rand() < 0.7 ? localToUtc(ZONE, addDays(MON, pick(weekdays)), 17 * 60) : null,
  hours: "work",
  nextUpRank: i < 2 ? i : null,
  createdAt: i,
  exclusions: [],
  changed: false,
}));

const habits: HabitItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `h${i}`,
  title: `Habit ${i}`,
  level: pick([1, 2, 3, 4] as const),
  rank: i,
  createdAt: i,
  hours: i % 3 === 0 ? "personal" : "work",
  idealMinute: i % 3 === 0 ? 19 * 60 : pick([9 * 60, 12 * 60, 15 * 60]),
  minMinutes: 15,
  maxMinutes: pick([30, 45, 60]),
  frequency: i % 2 === 0 ? { period: "daily" } : { period: "weekly", days: [1, 3, 5] },
  starting: null,
  defense: pick(["adaptive", "always-free", "always-busy"] as const),
  whenUnplaceable: "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
}));

const work = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [[540, 1020]]]));
const personal = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [[1080, 1320]]]));

const snapshot: Snapshot = {
  now: localToUtc(ZONE, addDays(MON, -1), 20 * 60),
  zone: ZONE,
  weekStart: 1,
  windowEnd: localToUtc(ZONE, addDays(MON, 14), 0),
  stepMinutes: 15,
  urgencyMode: "due-date-and-work",
  chunkCooldown: "none",
  breakMinutes: 10,
  hours: { work, personal } as Snapshot["hours"],
  workHours: ["work"],
  events,
  current: [],
  tasks,
  habits,
  buffers: [
    {
      id: "rec",
      title: "Recovery",
      level: 2,
      rank: 0,
      createdAt: 0,
      side: "after",
      minutesBefore: 0,
      minutesAfter: 15,
      busy: true,
      filter: { participants: { op: ">=", value: 4 } },
      onConflict: "remove",
      changed: false,
    },
    {
      id: "prep",
      title: "Prep",
      level: 3,
      rank: 1,
      createdAt: 1,
      side: "before",
      minutesBefore: 10,
      minutesAfter: 0,
      busy: true,
      filter: { length: { op: ">=", minutes: 60 } },
      onConflict: "remove",
      changed: false,
    },
  ],
  focus: [
    {
      id: "f",
      title: "Focus",
      rank: 0,
      createdAt: 0,
      hours: "work",
      weeklyGoalMinutes: 480,
      dailyMinMinutes: 60,
      dailyMaxMinutes: 180,
      minBlockMinutes: 60,
      maxBlockMinutes: 120,
      busy: true,
      exclusions: [],
      changed: false,
    },
  ],
};

const runs = Number(process.argv[2] ?? 200);
const firstStart = performance.now();
plan(snapshot);
const firstCallMs = (performance.now() - firstStart).toFixed(2);
for (let i = 0; i < 20; i++) plan(snapshot);
const times: number[] = [];
let result = plan(snapshot);
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  result = plan(snapshot);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const q = (p: number) =>
  (times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0).toFixed(2);
// Second run with the first plan as current placements (the steady state: stickiness).
const current = result.placements.map((p) => ({
  key: p.key,
  itemId: p.itemId,
  start: p.start,
  end: p.end,
  locked: false,
}));
const steady: number[] = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  plan({ ...snapshot, current });
  steady.push(performance.now() - t);
}
steady.sort((a, b) => a - b);
const qs = (p: number) =>
  (steady[Math.min(steady.length - 1, Math.floor(p * steady.length))] ?? 0).toFixed(2);
console.log(
  JSON.stringify(
    {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      node: process.version,
      runs,
      input: {
        tasks: tasks.length,
        habits: habits.length,
        meetings: events.length,
        buffers: 2,
        focus: 1,
        windowDays: 14,
      },
      output: { placements: result.placements.length, report: result.report.length },
      firstCallInProcessMs: firstCallMs,
      coldMs: { median: q(0.5), p95: q(0.95), max: q(1) },
      steadyMs: { median: qs(0.5), p95: qs(0.95), max: qs(1) },
    },
    null,
    2,
  ),
);
