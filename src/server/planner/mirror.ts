// Calendar mirroring: which source events get a copy, and how the copy looks
// (docs/specs/sync-calendar-mirroring.md rules 14-32).
import { hasTag } from "../../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import { all, type Db } from "../db.ts";
import type { DesiredEvent } from "./push.ts";
import { MANAGED_PROP } from "./push.ts";

export const TAG_NOSYNC = "#tl_nosync";
const LABELS = {
  personal: "Personal commitment",
  business: "Work commitment",
  travel: "Travel",
} as const;
export const COPY_NOTE =
  "Copied by Tempoloom from another calendar. Change the original event, not this copy.";

interface Policy {
  id: string;
  source_calendar_id: string;
  dest_calendar_id: string;
  calendar_type: keyof typeof LABELS;
  visibility: "label_only" | "busy_only" | "details_private" | "details_default";
  all_day_mode: "none" | "busy_only" | "all";
  copy_outside_work_hours: number;
  no_reply_busy: number;
}

interface SourceEvent {
  event_id: string;
  summary: string;
  description: string;
  start_ms: number;
  end_ms: number;
  all_day: number;
  busy: number;
  self_response: string | null;
  organizer_self: number;
  attendee_count: number;
  private_props: string;
}

/** The copies every enabled policy of the user wants, as desired managed events. */
export function mirrorCopies(
  db: Db,
  userId: string,
  zone: string,
  now: number,
  workHours: WeeklyHours | null,
): DesiredEvent[] {
  const out: DesiredEvent[] = [];
  const policies = all<Policy>(
    db,
    "SELECT * FROM mirror_policies WHERE user_id = ? AND enabled = 1",
    userId,
  );
  for (const p of policies) {
    const events = all<SourceEvent>(
      db,
      "SELECT * FROM events WHERE calendar_id = ? AND end_ms > ?",
      p.source_calendar_id,
      now,
    );
    const horizon = Math.max(now, ...events.map((e) => e.end_ms));
    const work = workHours ? hoursToTimeSet(workHours, zone, now, horizon) : null;
    for (const e of events) {
      const props = JSON.parse(e.private_props) as Record<string, string>;
      // No chaining: copies and other managed events are never copied again.
      if (props[MANAGED_PROP] === "1") continue;
      const tagged = { title: e.summary, description: e.description };
      if (hasTag(tagged, TAG_NOSYNC)) continue;
      if (e.self_response === "declined") continue;
      if (e.all_day && (p.all_day_mode === "none" || (p.all_day_mode === "busy_only" && !e.busy)))
        continue;
      if (
        !p.copy_outside_work_hours &&
        work &&
        !work.overlaps({ start: e.start_ms, end: e.end_ms })
      )
        continue;
      let busy: boolean;
      let fromSource = false;
      // Rule 21.2 applies to meetings the owner organizes without being an attendee.
      if (e.attendee_count > 0 && e.organizer_self && e.self_response === null) busy = true;
      else if (e.self_response === "accepted" || e.self_response === "tentative") busy = true;
      else if (e.self_response === "needsAction") busy = p.no_reply_busy === 1;
      else {
        busy = e.busy === 1;
        fromSource = true;
      }
      if (fromSource && !busy && (p.visibility === "label_only" || p.visibility === "busy_only"))
        continue;
      const details = p.visibility === "details_private" || p.visibility === "details_default";
      const title = details
        ? e.summary
        : p.visibility === "busy_only"
          ? "Busy"
          : LABELS[p.calendar_type];
      out.push({
        key: `mirror:${p.id}:${e.event_id}`,
        kind: "mirror",
        sourceId: p.id,
        calendarId: p.dest_calendar_id,
        start: e.start_ms,
        end: e.end_ms,
        title,
        description: details && e.description ? `${e.description}\n\n${COPY_NOTE}` : COPY_NOTE,
        busy,
        colorId: null,
      });
    }
  }
  return out;
}
