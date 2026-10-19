// Planned versus actual time (docs/specs/analytics-personal-stats.md rule 16,
// proposed). Planned: the managed event time on the calendar at the start of
// a day, rebuilt from Tempoloom's change log. Actual: the managed event time
// left on the calendar for that day. Only days that have ended count.
import { addDays, type LocalDate, localToUtc } from "../../shared/time.ts";
import { all, type Db } from "../db.ts";

const MIN = 60_000;

export interface LogEntry {
  key: string;
  /** "<kind>:<id>" of the managed item. */
  item: string;
  action: string;
  start: number | null;
  end: number | null;
  at: number;
}

export interface Placed {
  kind: string;
  start: number;
  end: number;
}

/** Kinds of planned work; copies and preview-mode writes are not planned work. */
const KINDS = new Set(["task", "habit", "focus", "buffer", "meeting"]);
const overlap = (s: number, e: number, a: number, b: number) =>
  Math.max(0, Math.min(e, b) - Math.max(s, a)) / MIN;

export function plannedVersusActual(input: {
  entries: LogEntry[];
  current: Placed[];
  zone: string;
  from: LocalDate;
  to: LocalDate;
  now: number;
}): { days: number; byKind: Record<string, { planned: number; actual: number }> } {
  const byKind: Record<string, { planned: number; actual: number }> = {};
  const add = (kind: string, field: "planned" | "actual", minutes: number) => {
    if (!KINDS.has(kind) || minutes <= 0) return;
    byKind[kind] ??= { planned: 0, actual: 0 };
    byKind[kind][field] += minutes;
  };
  const entries = [...input.entries].sort((a, b) => a.at - b.at);
  let days = 0;
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    const start = localToUtc(input.zone, d, 0);
    const end = localToUtc(input.zone, addDays(d, 1), 0);
    if (end > input.now) break;
    days++;
    // The calendar as it was at the start of the day: each key's last write before it.
    const state = new Map<string, LogEntry>();
    for (const e of entries) {
      if (e.at > start) break;
      state.set(e.key, e);
    }
    for (const e of state.values())
      if (e.action !== "delete" && e.start !== null && e.end !== null)
        add(e.item.split(":")[0] ?? "", "planned", overlap(e.start, e.end, start, end));
    for (const p of input.current) add(p.kind, "actual", overlap(p.start, p.end, start, end));
  }
  return { days, byKind };
}

/** Reads the change log and the managed events of one user for a date range. */
export function loadPlannedVersusActual(
  db: Db,
  userId: string,
  zone: string,
  from: LocalDate,
  to: LocalDate,
  now: number,
) {
  const start = localToUtc(zone, from, 0);
  const end = localToUtc(zone, addDays(to, 1), 0);
  const entries = all<LogEntry>(
    db,
    `SELECT event_key AS key, item, action, start_ms AS start, end_ms AS end, created_at AS at
     FROM change_log WHERE user_id = ? AND event_key <> '' AND created_at < ?`,
    userId,
    end,
  );
  const current = all<Placed>(
    db,
    `SELECT kind, start_ms AS start, end_ms AS end FROM managed_events
     WHERE user_id = ? AND event_id IS NOT NULL AND end_ms > ? AND start_ms < ?`,
    userId,
    start,
    end,
  );
  return plannedVersusActual({ entries, current, zone, from, to, now });
}
