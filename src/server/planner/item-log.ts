// The change log per item (docs/specs/planning-scheduler.md SCH-119): what each
// plan run did to an item's events, with the old and new times and a reason
// code. Skips and shortfalls carry the SCH-116 code of the run's report.
// Tempoloom decision: a move that the report does not explain gets
// "no-space-fixed" (another event now covers the old time), "no-space-priority"
// (another item of this run took it), "rules-changed" (the item's settings
// changed) or "rearranged" (the plan changed around it).
import type { Plan, ReportEntry, Snapshot } from "../../scheduler/model.ts";
import { all, type Db, run, tx } from "../db.ts";
import type { ManagedRow } from "./push.ts";

const DAY = 86_400_000;
export const ITEM_LOG_DAYS = 30;

type Action = "placed" | "moved" | "removed" | "skipped" | "conflict" | "status";

const overlaps = (a: { start: number; end: number }, start: number, end: number) =>
  a.start < end && a.end > start;

/** The report entry of a demand: an exact key, or the key of the demand a chunk belongs to. */
function entryFor(report: ReportEntry[], kind: string, itemId: string, key: string) {
  return report.find(
    (e) =>
      e.itemKind === kind &&
      e.itemId === itemId &&
      (key === e.demandKey || key.startsWith(`${e.demandKey}:`)),
  );
}

/** Logs the changes of one plan run: `before` is the managed rows the run started from. */
export function recordItemChanges(
  db: Db,
  userId: string,
  before: ManagedRow[],
  snapshot: Snapshot,
  result: Plan,
  now: number,
): void {
  const prevReport = JSON.parse(
    all<{ report: string }>(db, "SELECT report FROM plan_reports WHERE user_id = ?", userId)[0]
      ?.report ?? "[]",
  ) as ReportEntry[];
  const own = (r: ManagedRow) => r.kind !== "mirror" && r.end_ms > now;
  const was = new Map(before.filter(own).map((r) => [r.key, r]));
  const is = new Map(
    all<ManagedRow>(db, "SELECT * FROM managed_events WHERE user_id = ?", userId)
      .filter(own)
      .map((r) => [r.key, r]),
  );
  const changed = new Set(
    [
      ...snapshot.tasks.map((t) => ["task", t.id, t.changed] as const),
      ...snapshot.habits.map((h) => ["habit", h.id, h.changed] as const),
      ...snapshot.meetings.map((m) => ["meeting", m.id, m.changed] as const),
      ...snapshot.buffers.map((b) => ["buffer", b.id, b.changed] as const),
      ...snapshot.focus.map((f) => ["focus", f.id, f.changed] as const),
    ]
      .filter(([, , c]) => c)
      .map(([k, id]) => `${k}:${id}`),
  );
  const busy = snapshot.events.filter((e) => e.busy && !e.allDay);
  /** Why a placed event moved, when the report has no entry for it. */
  const moveReason = (b: ManagedRow): string => {
    if (busy.some((e) => overlaps(e, b.start_ms, b.end_ms))) return "no-space-fixed";
    if (result.placements.some((p) => p.key !== b.key && overlaps(p, b.start_ms, b.end_ms)))
      return "no-space-priority";
    return changed.has(`${b.kind}:${b.source_id}`) ? "rules-changed" : "rearranged";
  };

  const rows: {
    kind: string;
    itemId: string;
    key: string;
    action: Action;
    old: ManagedRow | undefined;
    now: ManagedRow | undefined;
    reason: string;
  }[] = [];
  const logged = new Set<string>();
  for (const key of new Set([...was.keys(), ...is.keys()])) {
    const b = was.get(key);
    const a = is.get(key);
    const r = (a ?? b) as ManagedRow;
    // Started events never change; their end is no move.
    if (b && b.start_ms <= now) continue;
    const entry = entryFor(result.report, r.kind, r.source_id, key);
    let action: Action;
    if (!b) action = "placed";
    else if (!a) action = "removed";
    else if (a.start_ms !== b.start_ms || a.end_ms !== b.end_ms) action = "moved";
    else continue;
    const reason =
      action === "placed" ? "" : (entry?.reason ?? (action === "moved" && b ? moveReason(b) : ""));
    rows.push({ kind: r.kind, itemId: r.source_id, key, action, old: b, now: a, reason });
    if (entry && action !== "placed") logged.add(entry.demandKey);
  }
  // A new shortfall that changed no event: a skipped period, a kept conflict or a new status.
  const seen = new Set(prevReport.map((e) => `${e.demandKey}|${e.status}|${e.reason}`));
  for (const e of result.report) {
    if (logged.has(e.demandKey) || seen.has(`${e.demandKey}|${e.status}|${e.reason}`)) continue;
    const action: Action =
      e.status === "conflict" ? "conflict" : e.status === "unplaced" ? "skipped" : "status";
    const placed = [...is.values()].find(
      (r) => r.key === e.demandKey || r.key.startsWith(`${e.demandKey}:`),
    );
    rows.push({
      kind: e.itemKind,
      itemId: e.itemId,
      key: e.demandKey,
      action,
      old: undefined,
      now: placed,
      reason: e.reason,
    });
  }
  tx(db, () => {
    for (const c of rows)
      run(
        db,
        `INSERT INTO item_changes (user_id, kind, item_id, demand_key, action, old_start, old_end,
           new_start, new_end, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId,
        c.kind,
        c.itemId,
        c.key,
        c.action,
        c.old?.start_ms ?? null,
        c.old?.end_ms ?? null,
        c.now?.start_ms ?? null,
        c.now?.end_ms ?? null,
        c.reason,
        now,
      );
    run(db, "DELETE FROM item_changes WHERE at < ?", now - ITEM_LOG_DAYS * DAY);
  });
}

export interface ItemChange {
  demand_key: string;
  action: Action;
  old_start: number | null;
  old_end: number | null;
  new_start: number | null;
  new_end: number | null;
  reason: string;
  at: number;
}

/** The log of one item, newest first. */
export function itemChanges(db: Db, userId: string, kind: string, itemId: string): ItemChange[] {
  return all<ItemChange>(
    db,
    `SELECT demand_key, action, old_start, old_end, new_start, new_end, reason, at FROM item_changes
     WHERE user_id = ? AND kind = ? AND item_id = ? ORDER BY at DESC, id DESC LIMIT 200`,
    userId,
    kind,
    itemId,
  );
}
