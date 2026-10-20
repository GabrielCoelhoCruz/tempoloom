// The change log per item (docs/specs/planning-scheduler.md SCH-116, SCH-119).
//
// Ways it can fail:
// 1. A removal does not carry the report's SCH-116 code.
// 2. A move gets the wrong reason: a busy event, another placement, a rule change.
// 3. A shortfall that the last run already reported is logged again on each run.
// 4. Mirror copies or started events are logged as item changes.
// 5. Entries older than 30 days are kept.
import { describe, expect, it } from "vitest";
import type { Plan, ReportEntry, Snapshot } from "../../src/scheduler/model.ts";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, type Db, openDb, run } from "../../src/server/db.ts";
import { itemChanges, recordItemChanges } from "../../src/server/planner/item-log.ts";
import type { ManagedRow } from "../../src/server/planner/push.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 8);

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW - 86_400_000);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'x', 'owner@example.com', '', 0, 1)`,
    user.id,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1)`,
  );
  return { db, userId: user.id };
}

function put(db: Db, userId: string, key: string, kind: string, start: number, end: number) {
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
     VALUES (?, ?, 'cal', ?, ?, ?, 'h1', ?, ?, 1, 'x')
     ON CONFLICT (user_id, key) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms`,
    key,
    userId,
    key,
    key,
    kind,
    start,
    end,
  );
}

const rows = (db: Db, userId: string) =>
  all<ManagedRow>(db, "SELECT * FROM managed_events WHERE user_id = ?", userId);

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    events: [],
    tasks: [],
    habits: [{ id: "h1", changed: false }],
    meetings: [],
    buffers: [],
    focus: [],
    ...over,
  } as unknown as Snapshot;
}
const busy = (start: number, end: number) => ({ start, end, busy: true, allDay: false });
const entry = (over: Partial<ReportEntry>): ReportEntry => ({
  itemKind: "habit",
  itemId: "h1",
  demandKey: "habit:h1:2026-11-03",
  requiredMinutes: 60,
  placedMinutes: 0,
  missingMinutes: 60,
  status: "unplaced",
  reason: "no-space-fixed",
  ...over,
});

describe("recordItemChanges", () => {
  it("logs a removal with the report's code, and a move with the reason of its old time", () => {
    const { db, userId } = setup();
    const t = NOW + 24 * H;
    put(db, userId, "habit:h1:2026-11-03", "habit", t, t + H);
    put(db, userId, "habit:h1:2026-11-04", "habit", t + 24 * H, t + 25 * H);
    put(db, userId, "habit:h1:2026-11-05", "habit", t + 48 * H, t + 49 * H);
    const before = rows(db, userId);
    run(db, "DELETE FROM managed_events WHERE key = 'habit:h1:2026-11-03'");
    put(db, userId, "habit:h1:2026-11-04", "habit", t + 26 * H, t + 27 * H);
    put(db, userId, "habit:h1:2026-11-05", "habit", t + 50 * H, t + 51 * H);
    const plan: Plan = {
      placements: [
        {
          key: "task:t1:0",
          kind: "task",
          itemId: "t1",
          start: t + 48 * H,
          end: t + 49 * H,
          busy: true,
          locked: false,
          conflict: false,
          afterDue: false,
        },
      ],
      report: [entry({})],
    };
    recordItemChanges(
      db,
      userId,
      before,
      snapshot({ events: [busy(t + 24 * H, t + 25 * H)] as Snapshot["events"] }),
      plan,
      NOW,
    );
    const log = itemChanges(db, userId, "habit", "h1");
    const of = (day: string) =>
      log.filter((c) => c.demand_key.endsWith(day)).map((c) => [c.action, c.reason]);
    expect(of("11-03")).toEqual([["removed", "no-space-fixed"]]);
    expect(of("11-04")).toEqual([["moved", "no-space-fixed"]]);
    expect(of("11-05")).toEqual([["moved", "no-space-priority"]]);
    // The removal explains the report entry: no second "skipped" entry.
    expect(log).toHaveLength(3);
  });

  it("names a rule change, skips mirror copies and started events, and logs a shortfall once", () => {
    const { db, userId } = setup();
    const t = NOW + 24 * H;
    put(db, userId, "habit:h1:2026-11-03", "habit", t, t + H);
    put(db, userId, "mirror:p:e1", "mirror", t, t + H);
    put(db, userId, "habit:h1:2026-11-02", "habit", NOW - H, NOW + H);
    const before = rows(db, userId);
    put(db, userId, "habit:h1:2026-11-03", "habit", t + 2 * H, t + 3 * H);
    put(db, userId, "mirror:p:e1", "mirror", t + 2 * H, t + 3 * H);
    put(db, userId, "habit:h1:2026-11-02", "habit", NOW - H, NOW + 2 * H);
    const skipped = entry({ demandKey: "habit:h1:2026-11-06", reason: "away" });
    const changed = snapshot({ habits: [{ id: "h1", changed: true }] as Snapshot["habits"] });
    recordItemChanges(db, userId, before, changed, { placements: [], report: [skipped] }, NOW);
    run(
      db,
      "INSERT INTO plan_reports (user_id, report, planned_at) VALUES (?, ?, ?)",
      userId,
      JSON.stringify([skipped]),
      NOW,
    );
    recordItemChanges(
      db,
      userId,
      rows(db, userId),
      snapshot(),
      { placements: [], report: [skipped] },
      NOW + 1,
    );
    expect(
      itemChanges(db, userId, "habit", "h1").map((c) => [c.demand_key, c.action, c.reason]),
    ).toEqual([
      ["habit:h1:2026-11-06", "skipped", "away"],
      ["habit:h1:2026-11-03", "moved", "rules-changed"],
    ]);
    expect(itemChanges(db, userId, "mirror", "h1")).toEqual([]);
  });

  it("deletes entries older than 30 days", () => {
    const { db, userId } = setup();
    const old = entry({ demandKey: "habit:h1:2026-09-01" });
    recordItemChanges(
      db,
      userId,
      [],
      snapshot(),
      { placements: [], report: [old] },
      NOW - 31 * 24 * H,
    );
    expect(itemChanges(db, userId, "habit", "h1")).toHaveLength(1);
    recordItemChanges(db, userId, [], snapshot(), { placements: [], report: [] }, NOW);
    expect(itemChanges(db, userId, "habit", "h1")).toHaveLength(0);
  });
});
