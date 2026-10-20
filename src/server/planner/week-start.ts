// A week start read from Google takes effect at the start of the next week
// (docs/specs/settings-profile.md edge case 3). Weekly meeting occurrences are
// keyed by the start of their week (`meeting:<id>:<week start>`), so the switch
// moves every state kept by that key to the new key in one transaction: placed
// occurrences (the push then keeps their events instead of deleting them and
// sending new invitations), skipped weeks (dismissed keys) and declines that
// wait for their move.
import type { MeetingFrequency } from "../../scheduler/model.ts";
import { meetingAnchor, meetingPeriodStart } from "../../scheduler/plan.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { getSettings, updateSettings } from "../settings.ts";

interface WeeklyMeeting {
  id: string;
  f: Extract<MeetingFrequency, { period: "weekly" }>;
  anchor: LocalDate;
}

const weekOf = (d: LocalDate, weekStart: 1 | 7) =>
  addDays(d, -((weekdayOf(d) - weekStart + 7) % 7));

export function applyPendingWeekStart(db: Db, userId: string, zone: string, now: number): void {
  const next = getSettings(db, userId).weekStartNext;
  const today = utcToLocal(zone, now).date;
  if (!next || today < next.from) return;
  const weekStart = next.weekStart;
  // Rows from the start of the new week that holds today: an occurrence held
  // earlier in that week takes the new key too, so it still counts as done.
  const since = weekOf(today, weekStart);
  const meetings = new Map<string, WeeklyMeeting>();
  for (const m of all<{
    id: string;
    frequency: string;
    starting: string | null;
    created_at: number;
  }>(db, "SELECT id, frequency, starting, created_at FROM meetings WHERE user_id = ?", userId)) {
    const f = JSON.parse(m.frequency) as MeetingFrequency;
    if (f.period !== "weekly") continue;
    const anchor = meetingAnchor(zone, { starting: m.starting, createdAt: m.created_at });
    meetings.set(m.id, { id: m.id, f, anchor });
  }
  const keyOf = (m: WeeklyMeeting, date: LocalDate) => {
    const period = meetingPeriodStart(m.f, date, weekStart, m.anchor);
    return period ? `meeting:${m.id}:${period}` : null;
  };
  const moved = new Map<string, string>();

  tx(db, () => {
    // Locked rows first, then by start: a locked occurrence never loses its key to another.
    for (const r of all<{ id: string; key: string; source_id: string; start_ms: number }>(
      db,
      `SELECT id, key, source_id, start_ms FROM managed_events
       WHERE user_id = ? AND kind = 'meeting' AND start_ms >= ? ORDER BY locked DESC, start_ms, id`,
      userId,
      localToUtc(zone, since, 0),
    )) {
      const m = meetings.get(r.source_id);
      if (!m) continue;
      const key = keyOf(m, utcToLocal(zone, r.start_ms).date);
      // Two occurrences in one new week: the second keeps its key, and the plan drops it.
      if (
        !key ||
        key === r.key ||
        one(db, "SELECT 1 FROM managed_events WHERE user_id = ? AND key = ?", userId, key)
      )
        continue;
      run(db, "UPDATE managed_events SET key = ? WHERE id = ?", key, r.id);
      moved.set(r.key, key);
    }
    for (const [from, to] of moved)
      run(
        db,
        `UPDATE meeting_changes SET occurrence_key = ? WHERE user_id = ? AND occurrence_key = ?
           AND reason = 'declined' AND new_start IS NULL`,
        to,
        userId,
        from,
      );

    // A skipped week has no row: its new period is the one that holds the old
    // week's first ideal day (else its middle day).
    for (const d of all<{ key: string }>(
      db,
      "SELECT key FROM dismissed_keys WHERE user_id = ? AND key LIKE 'meeting:%'",
      userId,
    )) {
      const cut = d.key.lastIndexOf(":");
      const m = meetings.get(d.key.slice("meeting:".length, cut));
      const old = d.key.slice(cut + 1) as LocalDate;
      if (!m || addDays(old, 6) < since) continue;
      const days = Array.from({ length: 7 }, (_, i) => addDays(old, i));
      const ideal = days.find((x) => m.f.idealDays.includes(weekdayOf(x))) ?? addDays(old, 3);
      const key = keyOf(m, ideal);
      if (!key || key === d.key) continue;
      run(db, "DELETE FROM dismissed_keys WHERE user_id = ? AND key = ?", userId, d.key);
      run(db, "INSERT OR IGNORE INTO dismissed_keys (user_id, key) VALUES (?, ?)", userId, key);
    }
    updateSettings(db, userId, { weekStart, weekStartNext: null });
  });
}
