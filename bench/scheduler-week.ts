// Solver time for a realistic week: 50 tasks, 10 habits and 30 meetings over
// a 14-day window, plus 2 buffer automations and a focus goal.
// Usage: node bench/scheduler-week.ts [runs]
import { cpus } from "node:os";
import { plan } from "../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../src/shared/time.ts";
import { benchSnapshot } from "./week-fixture.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const snapshot = benchSnapshot(ZONE, MON, localToUtc(ZONE, addDays(MON, -1), 20 * 60));
const { tasks, habits, events } = snapshot;

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
