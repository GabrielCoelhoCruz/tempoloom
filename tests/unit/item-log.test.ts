// The change log per item (docs/specs/planning-scheduler.md SCH-116, SCH-119).
//
// Ways it can fail:
// 1. A removal does not carry the report's SCH-116 code.
// 2. A move gets the wrong reason: a busy event, another placement, a rule change.
// 3. A shortfall that the last run already reported is logged again on each run.
// 4. Mirror copies or started events are logged as item changes.
// 5. Entries older than 30 days are kept.
// 6. A run that changed nothing writes to the database (cost on every run).
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

type W = Map<string, { start: number; end: number } | null>;
const moved = (
  key: string,
  start: number,
  end: number,
): [string, { start: number; end: number }] => [key, { start, end }];
const log = (
  db: Db,
  userId: string,
  before: ManagedRow[],
  written: W,
  snap: Snapshot,
  result: Plan,
  now: number,
  prevReport: ReportEntry[] = [],
) =>
  recordItemChanges(db, userId, {
    before,
    written,
    prevReport: JSON.stringify(prevReport),
    snapshot: snap,
    result,
    now,
  });

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
    const written: W = new Map([
      ["habit:h1:2026-11-03", null],
      moved("habit:h1:2026-11-04", t + 26 * H, t + 27 * H),
      moved("habit:h1:2026-11-05", t + 50 * H, t + 51 * H),
    ]);
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
    log(
      db,
      userId,
      before,
      written,
      snapshot({ events: [busy(t + 24 * H, t + 25 * H)] as Snapshot["events"] }),
      plan,
      NOW,
    );
    const changes = itemChanges(db, userId, "habit", "h1", NOW);
    const of = (day: string) =>
      changes.filter((c) => c.demand_key.endsWith(day)).map((c) => [c.action, c.reason]);
    expect(of("11-03")).toEqual([["removed", "no-space-fixed"]]);
    expect(of("11-04")).toEqual([["moved", "no-space-fixed"]]);
    expect(of("11-05")).toEqual([["moved", "no-space-priority"]]);
    // The removal explains the report entry: no second "skipped" entry.
    expect(changes).toHaveLength(3);
  });

  it("names a rule change, skips mirror copies and started events, and logs a shortfall once", () => {
    const { db, userId } = setup();
    const t = NOW + 24 * H;
    put(db, userId, "habit:h1:2026-11-03", "habit", t, t + H);
    put(db, userId, "mirror:p:e1", "mirror", t, t + H);
    put(db, userId, "habit:h1:2026-11-02", "habit", NOW - H, NOW + H);
    const before = rows(db, userId);
    const written: W = new Map([
      moved("habit:h1:2026-11-03", t + 2 * H, t + 3 * H),
      moved("mirror:p:e1", t + 2 * H, t + 3 * H),
      moved("habit:h1:2026-11-02", NOW - H, NOW + 2 * H),
    ]);
    const skipped = entry({ demandKey: "habit:h1:2026-11-06", reason: "away" });
    const changed = snapshot({ habits: [{ id: "h1", changed: true }] as Snapshot["habits"] });
    log(db, userId, before, written, changed, { placements: [], report: [skipped] }, NOW);
    log(db, userId, before, new Map(), snapshot(), { placements: [], report: [skipped] }, NOW + 1, [
      skipped,
    ]);
    expect(
      itemChanges(db, userId, "habit", "h1", NOW).map((c) => [c.demand_key, c.action, c.reason]),
    ).toEqual([
      ["habit:h1:2026-11-06", "skipped", "away"],
      ["habit:h1:2026-11-03", "moved", "rules-changed"],
    ]);
    expect(itemChanges(db, userId, "mirror", "h1", NOW)).toEqual([]);
  });

  it("logs a new event as placed, and a kept conflict and a status change with the event's time", () => {
    const { db, userId } = setup();
    const t = NOW + 24 * H;
    put(db, userId, "habit:h1:2026-11-03", "habit", t, t + H);
    const before = rows(db, userId);
    const conflict = entry({
      demandKey: "habit:h1:2026-11-03",
      status: "conflict",
      reason: "no-space-fixed",
    });
    const late = entry({
      itemKind: "task",
      itemId: "t1",
      demandKey: "task:t1",
      status: "after-due",
      reason: "after-due",
    });
    const plan: Plan = {
      placements: [
        {
          key: "task:t1:0",
          kind: "task",
          itemId: "t1",
          start: t + 2 * H,
          end: t + 3 * H,
          busy: true,
          locked: false,
          conflict: false,
          afterDue: true,
        },
      ],
      report: [conflict, late],
    };
    log(
      db,
      userId,
      before,
      new Map([moved("task:t1:0", t + 2 * H, t + 3 * H)]),
      snapshot(),
      plan,
      NOW,
    );
    expect(
      itemChanges(db, userId, "habit", "h1", NOW).map((c) => [c.action, c.reason, c.new_start]),
    ).toEqual([["conflict", "no-space-fixed", t]]);
    expect(
      itemChanges(db, userId, "task", "t1", NOW).map((c) => [c.action, c.reason, c.new_start]),
    ).toEqual([
      ["status", "after-due", t + 2 * H],
      ["placed", "", t + 2 * H],
    ]);
  });

  it("writes nothing on a run that changed nothing", () => {
    const { db, userId } = setup();
    const t = NOW + 24 * H;
    put(db, userId, "habit:h1:2026-11-03", "habit", t, t + H);
    const skipped = entry({ demandKey: "habit:h1:2026-11-06", reason: "away" });
    // An entry older than 30 days stays until a run writes: the read hides it.
    run(
      db,
      `INSERT INTO item_changes (user_id, kind, item_id, demand_key, action, reason, at)
       VALUES (?, 'habit', 'h1', 'habit:h1:2026-09-01', 'skipped', 'away', ?)`,
      userId,
      NOW - 31 * 24 * H,
    );
    const total = () => all<{ n: number }>(db, "SELECT count(*) AS n FROM item_changes")[0]?.n ?? 0;
    const changesBefore = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    log(
      db,
      userId,
      rows(db, userId),
      new Map(),
      snapshot(),
      { placements: [], report: [skipped] },
      NOW,
      [skipped],
    );
    const changesAfter = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    expect(changesAfter.n).toBe(changesBefore.n);
    expect(total()).toBe(1);
    expect(itemChanges(db, userId, "habit", "h1", NOW)).toEqual([]);
  });

  it("deletes the user's entries older than 30 days when it writes", () => {
    const { db, userId } = setup();
    const old = entry({ demandKey: "habit:h1:2026-09-01" });
    log(
      db,
      userId,
      [],
      new Map(),
      snapshot(),
      { placements: [], report: [old] },
      NOW - 31 * 24 * H,
    );
    expect(itemChanges(db, userId, "habit", "h1", NOW - 31 * 24 * H)).toHaveLength(1);
    log(db, userId, [], new Map(), snapshot(), { placements: [], report: [entry({})] }, NOW);
    expect(
      all<{ k: string }>(db, "SELECT demand_key AS k FROM item_changes").map((r) => r.k),
    ).toEqual(["habit:h1:2026-11-03"]);
  });
});
