// The change log per item (docs/specs/planning-scheduler.md SCH-119): what each
// plan run did to an item's events, with the old and new times and a reason
// code. Skips and shortfalls carry the SCH-116 code of the run's report.
// Tempoloom decision: a move that the report does not explain gets
// "no-space-fixed" (another event now covers the old time), "no-space-priority"
// (another item of this run took it), "rules-changed" (the item's settings
// changed) or "rearranged" (the plan changed around it); a snooze that moves a
// started event gets "snoozed".
import type { Plan, ReportEntry, Snapshot } from "../../scheduler/model.ts";
import { all, type Db, run as dbRun } from "../db.ts";
import type { ManagedRow } from "./push.ts";

const DAY = 86_400_000;
export const ITEM_LOG_DAYS = 30;

type Action = "placed" | "moved" | "removed" | "skipped" | "conflict" | "status";

const overlaps = (a: { start: number; end: number }, start: number, end: number) =>
  a.start < end && a.end > start;

/** What a push wrote per managed key: the new times, or null for a delete. */
export type Written = ReadonlyMap<string, { start: number; end: number } | null>;

/** The demand key of a report entry that a managed key belongs to: itself, or the demand of a chunk. */
function demandOf(byDemand: Map<string, ReportEntry>, key: string): ReportEntry | undefined {
  for (let k = key; ; k = k.slice(0, k.lastIndexOf(":"))) {
    const e = byDemand.get(k);
    if (e) return e;
    if (k.indexOf(":") === k.lastIndexOf(":")) return undefined;
  }
}

/**
 * Logs the changes of one plan run. `before` is the managed rows the run
 * started from, `written` what its push wrote, `prevReport` the report of the
 * run before (JSON). A run that changed nothing writes nothing.
 */
export function recordItemChanges(
  db: Db,
  userId: string,
  run: {
    before: readonly ManagedRow[];
    written: Written;
    prevReport: string | null;
    /** This run's report as JSON, when known: equal to `prevReport` means no new shortfall. */
    reportJson?: string;
    /** False after a failed push: skips, conflicts and status changes wait for a whole run. */
    shortfalls?: boolean;
    snapshot: Snapshot;
    result: Plan;
    now: number;
  },
): void {
  const { before, written, snapshot, result, now } = run;
  const own = (r: { kind: string; end_ms: number }) => r.kind !== "mirror" && r.end_ms > now;
  const byDemand = new Map<string, ReportEntry>();
  for (const e of result.report) if (!byDemand.has(e.demandKey)) byDemand.set(e.demandKey, e);

  type Row = {
    kind: string;
    itemId: string;
    key: string;
    action: Action;
    old: { start: number; end: number } | undefined;
    now: { start: number; end: number } | undefined;
    reason: string;
  };
  const rows: Row[] = [];
  const logged = new Set<string>();
  /** The times of each demand's event after the push, for shortfall entries. */
  const placedAt = new Map<string, { start: number; end: number }>();
  const beforeKeys = new Set<string>();
  let changed: Set<string> | undefined;
  let busy: Snapshot["events"] | undefined;
  /** Why a placed event moved (Tempoloom decision, SCH-119). */
  const moveReason = (b: ManagedRow): string => {
    busy ??= snapshot.events.filter((e) => e.busy && !e.allDay);
    if (busy.some((e) => overlaps(e, b.start_ms, b.end_ms))) return "no-space-fixed";
    if (result.placements.some((p) => p.key !== b.key && overlaps(p, b.start_ms, b.end_ms)))
      return "no-space-priority";
    changed ??= new Set(
      [
        ...snapshot.tasks.map((t) => ["task", t.id, t.changed] as const),
        ...snapshot.habits.map((h) => ["habit", h.id, h.changed] as const),
        ...snapshot.meetings.map((m) => ["meeting", m.id, m.changed] as const),
        ...snapshot.buffers.map((x) => ["buffer", x.id, x.changed] as const),
        ...snapshot.focus.map((f) => ["focus", f.id, f.changed] as const),
        ...(snapshot.overloads ?? []).map((o) => ["focus", o.id, o.changed] as const),
      ]
        .filter(([, , c]) => c)
        .map(([k, id]) => `${k}:${id}`),
    );
    return changed.has(`${b.kind}:${b.source_id}`) ? "rules-changed" : "rearranged";
  };

  for (const b of before) {
    if (!own(b)) continue;
    beforeKeys.add(b.key);
    const w = written.get(b.key);
    const after = w === undefined ? { start: b.start_ms, end: b.end_ms } : w;
    if (after) {
      const e = demandOf(byDemand, b.key);
      if (e && !placedAt.has(e.demandKey)) placedAt.set(e.demandKey, after);
    }
    if (w === undefined) continue;
    // A started event changes only when a snooze moves it to a later start
    // (SCH-60a); a new end of a started event is no move.
    const snoozed = b.start_ms <= now;
    if (snoozed && (w === null || w.start <= now)) continue;
    const old = { start: b.start_ms, end: b.end_ms };
    if (w === null) {
      const e = demandOf(byDemand, b.key);
      if (e) logged.add(e.demandKey);
      rows.push({
        kind: b.kind,
        itemId: b.source_id,
        key: b.key,
        action: "removed",
        old,
        now: undefined,
        reason: e?.reason ?? "",
      });
    } else if (w.start !== b.start_ms || w.end !== b.end_ms) {
      rows.push({
        kind: b.kind,
        itemId: b.source_id,
        key: b.key,
        action: "moved",
        old,
        now: w,
        reason: snoozed ? "snoozed" : moveReason(b),
      });
    }
  }
  if (written.size > 0)
    for (const p of result.placements) {
      const w = written.get(p.key);
      if (!w || beforeKeys.has(p.key)) continue;
      const e = demandOf(byDemand, p.key);
      if (e && !placedAt.has(e.demandKey)) placedAt.set(e.demandKey, w);
      rows.push({
        kind: p.kind,
        itemId: p.itemId,
        key: p.key,
        action: "placed",
        old: undefined,
        now: w,
        reason: "",
      });
    }
  // A new shortfall that changed no event: a skipped period, a kept conflict or a new status.
  if (run.shortfalls !== false && byDemand.size > 0 && run.reportJson !== run.prevReport) {
    const seen = new Set(
      (JSON.parse(run.prevReport ?? "[]") as ReportEntry[]).map(
        (e) => `${e.demandKey}|${e.status}|${e.reason}`,
      ),
    );
    for (const e of byDemand.values()) {
      if (logged.has(e.demandKey) || seen.has(`${e.demandKey}|${e.status}|${e.reason}`)) continue;
      rows.push({
        kind: e.itemKind,
        itemId: e.itemId,
        key: e.demandKey,
        action:
          e.status === "conflict" ? "conflict" : e.status === "unplaced" ? "skipped" : "status",
        old: undefined,
        now: placedAt.get(e.demandKey),
        reason: e.reason,
      });
    }
  }
  if (rows.length === 0) return;
  // One statement per 500 rows (SQLite takes at most 32,766 values in one statement).
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    dbRun(
      db,
      `INSERT INTO item_changes (user_id, kind, item_id, demand_key, action, old_start, old_end,
         new_start, new_end, reason, at) VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      ...part.flatMap((c) => [
        userId,
        c.kind,
        c.itemId,
        c.key,
        c.action,
        c.old?.start ?? null,
        c.old?.end ?? null,
        c.now?.start ?? null,
        c.now?.end ?? null,
        c.reason,
        now,
      ]),
    );
  }
  // Then the user's entries older than 30 days.
  dbRun(
    db,
    "DELETE FROM item_changes WHERE user_id = ? AND at < ?",
    userId,
    now - ITEM_LOG_DAYS * DAY,
  );
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
export function itemChanges(
  db: Db,
  userId: string,
  kind: string,
  itemId: string,
  now: number,
): ItemChange[] {
  return all<ItemChange>(
    db,
    `SELECT demand_key, action, old_start, old_end, new_start, new_end, reason, at FROM item_changes
     WHERE user_id = ? AND kind = ? AND item_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT 200`,
    userId,
    kind,
    itemId,
    now - ITEM_LOG_DAYS * DAY,
  );
}
