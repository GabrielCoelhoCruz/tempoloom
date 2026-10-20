// A week start read from Google takes effect at the start of the next week
// (docs/specs/settings-profile.md edge case 3). Weekly meeting occurrences are
// keyed by the start of their week (`meeting:<id>:<week start>`), so the switch
// moves the placed occurrences to their new keys: the push then keeps the
// events instead of deleting them and sending new invitations.
import type { MeetingFrequency } from "../../scheduler/model.ts";
import { meetingAnchor, meetingPeriodStart } from "../../scheduler/plan.ts";
import { utcToLocal } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { getSettings, updateSettings } from "../settings.ts";

export function applyPendingWeekStart(db: Db, userId: string, zone: string, now: number): void {
  const next = getSettings(db, userId).weekStartNext;
  if (!next || utcToLocal(zone, now).date < next.from) return;
  tx(db, () => {
    for (const r of all<{
      id: string;
      key: string;
      start_ms: number;
      frequency: string;
      starting: string | null;
      created_at: number;
    }>(
      db,
      `SELECT e.id, e.key, e.start_ms, m.frequency, m.starting, m.created_at
       FROM managed_events e JOIN meetings m ON m.id = e.source_id
       WHERE e.user_id = ? AND e.kind = 'meeting' AND e.end_ms > ?`,
      userId,
      now,
    )) {
      const f = JSON.parse(r.frequency) as MeetingFrequency;
      if (f.period !== "weekly") continue;
      const anchor = meetingAnchor(zone, { starting: r.starting, createdAt: r.created_at });
      const period = meetingPeriodStart(
        f,
        utcToLocal(zone, r.start_ms).date,
        next.weekStart,
        anchor,
      );
      if (!period) continue;
      const key = `${r.key.slice(0, r.key.lastIndexOf(":"))}:${period}`;
      // Two occurrences in one new week: the second keeps its key, and the plan drops it.
      if (
        key === r.key ||
        one(db, "SELECT 1 FROM managed_events WHERE user_id = ? AND key = ?", userId, key)
      )
        continue;
      run(db, "UPDATE managed_events SET key = ? WHERE id = ?", key, r.id);
    }
    updateSettings(db, userId, { weekStart: next.weekStart, weekStartNext: null });
  });
}
