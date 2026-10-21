// Cost of the change log per item (planning-scheduler.md SCH-119) on one plan
// run, for the benchmark week: the managed events of the week's plan in a
// file database, then the log step of a run that changed nothing (the usual
// run) and of a run that moved 10 events.
// Usage: node bench/change-log.ts [runs]
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../src/scheduler/plan.ts";
import { ensureUser } from "../src/server/accounts.ts";
import { all, openDb, run } from "../src/server/db.ts";
import { recordItemChanges } from "../src/server/planner/item-log.ts";
import type { ManagedRow } from "../src/server/planner/push.ts";
import { addDays, localToUtc } from "../src/shared/time.ts";
import { benchSnapshot } from "./week-fixture.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const NOW = localToUtc(ZONE, addDays(MON, -1), 20 * 60);
const RUNS = Number(process.argv[2] ?? 200);
const snapshot = benchSnapshot(ZONE, MON, NOW);
const result = plan(snapshot);

const dir = mkdtempSync(join(tmpdir(), "tempoloom-bench-log-"));
const db = openDb(join(dir, "tempoloom.db"));
const user = ensureUser(db, "bench@tempoloom.test", "Bench", NOW - 86_400_000);
run(
  db,
  `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
   VALUES ('acc', ?, 'caldav', 'x', 'bench@tempoloom.test', '', 0, 1)`,
  user.id,
);
run(
  db,
  `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
   VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1)`,
);
for (const p of result.placements)
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
     VALUES (?, ?, 'cal', ?, ?, ?, ?, ?, ?, 1, 'x')`,
    randomUUID(),
    user.id,
    randomUUID(),
    p.key,
    p.kind,
    p.itemId,
    p.start,
    p.end,
  );
const report = JSON.stringify(result.report);
run(
  db,
  "INSERT INTO plan_reports (user_id, report, planned_at) VALUES (?, ?, ?)",
  user.id,
  report,
  NOW,
);
const before = all<ManagedRow>(db, "SELECT * FROM managed_events WHERE user_id = ?", user.id);

const measure = (written: (i: number) => Map<string, { start: number; end: number } | null>) => {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const w = written(i);
    const t = performance.now();
    recordItemChanges(db, user.id, {
      before,
      written: w,
      prevReport: report,
      reportJson: report,
      snapshot,
      result,
      now: NOW + i,
    });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const q = (p: number) =>
    (times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0).toFixed(3);
  return { median: q(0.5), p95: q(0.95), max: q(1) };
};

const MIN = 60_000;
const unchangedMs = measure(() => new Map());
// Ten events move by 15 minutes, alternately forward and back, on each run.
const movable = before.filter((r) => r.start_ms > NOW).slice(0, 10);
const tenMovesMs = measure(
  (i) =>
    new Map(
      movable.map((r) => {
        const d = i % 2 === 0 ? 15 * MIN : 0;
        return [r.key, { start: r.start_ms + d, end: r.end_ms + d }];
      }),
    ),
);
const rows = all<{ n: number }>(db, "SELECT count(*) AS n FROM item_changes")[0]?.n ?? 0;
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(
  JSON.stringify(
    {
      changeLog: {
        runs: RUNS,
        managedEvents: before.length,
        reportEntries: result.report.length,
        unchangedMs,
        tenMovesMs,
        rowsWritten: rows,
      },
    },
    null,
    2,
  ),
);
