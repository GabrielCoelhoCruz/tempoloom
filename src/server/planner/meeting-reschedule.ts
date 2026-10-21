// The reschedule action on one flexible meeting occurrence
// (docs/specs/meetings-flexible-rescheduling.md rule 19; rule 26 for the guest
// of a 1:1): the best slot of the occurrence's period that matches the option
// and is not the current time, found by the scheduler with the organizer's data.

import { plan } from "../../scheduler/plan.ts";
import type { Interval } from "../../scheduler/timeset.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal } from "../../shared/time.ts";
import { type Db, one } from "../db.ts";
import { getSettings } from "../settings.ts";
import { planningZone } from "../travel.ts";
import type { ManagedRow } from "./push.ts";
import { loadSnapshot } from "./replan.ts";

/** "a different time, same day" or "another day in the same period". */
export type RescheduleOption = "sameDay" | "otherDay";

export function rescheduleSlot(
  db: Db,
  organizerId: string,
  row: ManagedRow,
  option: RescheduleOption,
  now: number,
): Interval | null {
  const zone = planningZone(db, organizerId);
  const last =
    one<{ planned_at: number }>(
      db,
      "SELECT planned_at FROM plan_reports WHERE user_id = ?",
      organizerId,
    )?.planned_at ?? 0;
  const { snapshot } = loadSnapshot(db, organizerId, zone, getSettings(db, organizerId), now, last);
  const item = snapshot.meetings.find((m) => m.id === row.source_id);
  if (!item) return null;
  const date = utcToLocal(zone, row.start_ms).date;
  const dayStart = localToUtc(zone, date, 0);
  const dayEnd = localToUtc(zone, addDays(date, 1), 0);
  // The current time is never the result; the option keeps or leaves its day.
  const away =
    option === "sameDay"
      ? [
          { start: now, end: dayStart },
          { start: dayEnd, end: snapshot.windowEnd },
        ]
      : [{ start: dayStart, end: dayEnd }];
  const exclusions = [{ start: row.start_ms, end: row.end_ms }, ...away].filter(
    (x) => x.end > x.start,
  );
  const result = plan({
    ...snapshot,
    // A manual action: a locked occurrence moves too, and comes out unlocked.
    current: snapshot.current.map((c) => (c.key === row.key ? { ...c, locked: false } : c)),
    meetings: [
      ...snapshot.meetings.filter((m) => m.id !== item.id),
      {
        ...item,
        periods: [row.key.slice(row.key.lastIndexOf(":") + 1) as LocalDate],
        changed: true,
        // The lead time and the move limit are for automatic moves only.
        leadMinutes: 0,
        exclusions: [...item.exclusions, ...exclusions],
      },
    ],
  });
  const p = result.placements.find((x) => x.key === row.key && !x.conflict);
  return p ? { start: p.start, end: p.end } : null;
}
