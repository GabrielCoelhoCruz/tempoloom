// Calendar mirroring: which source events get a copy, and how the copy looks
// (docs/specs/sync-calendar-mirroring.md rules 14-32).
import { hasTag } from "../../scheduler/blocking.ts";
import { type Category, categoryOf } from "../../scheduler/categories.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import { all, type Db } from "../db.ts";
import { MIRROR_WINDOW } from "../sync/pull.ts";
import { categoryContext } from "./categories.ts";
import type { DesiredEvent } from "./push.ts";
import { MANAGED_PROP } from "./push.ts";

export const TAG_NOSYNC = "#tl_nosync";
export const LABELS = {
  personal: "Personal commitment",
  business: "Work commitment",
  travel: "Travel",
} as const;
export const COPY_NOTE =
  "Copied by Tempoloom from another calendar. Change the original event, not this copy.";

/** The managed key of the copy of one source event under one policy. */
export const mirrorKey = (policyId: string, sourceEventId: string) =>
  `mirror:${policyId}:${sourceEventId}`;

/** The source event id in the key of a copy made by the policy. */
export const mirrorSource = (key: string, policyId: string) =>
  key.slice(mirrorKey(policyId, "").length);

const MEETINGS: Category[] = ["team_meeting", "one_on_one", "external_meeting"];

/**
 * The label of a copy (rule 27): the row is the category of the source event,
 * the column the policy's calendar type; an empty cell uses "any other".
 */
export function copyLabel(category: Category, type: keyof typeof LABELS): string {
  if (category === "vacation" && type === "personal") return "PTO";
  if (category === "travel") return "Travel";
  if (category === "flight") return "Flight";
  if (MEETINGS.includes(category) && type === "business") return "Meeting";
  return LABELS[type];
}

interface Policy {
  id: string;
  source_calendar_id: string;
  dest_calendar_id: string;
  calendar_type: keyof typeof LABELS;
  visibility: "label_only" | "busy_only" | "details_private" | "details_default";
  all_day_mode: "none" | "busy_only" | "all";
  copy_outside_work_hours: number;
  no_reply_busy: number;
  /** The destination's calendar id and, for a primary calendar, its account email. */
  dest_provider_id: string;
  dest_email: string | null;
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
  attendees: string;
  event_type: string;
  location: string;
  calendar_id: string;
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
    `SELECT p.*, d.provider_id AS dest_provider_id,
       CASE WHEN d.is_primary = 1 THEN a.email END AS dest_email
     FROM mirror_policies p JOIN calendars d ON d.id = p.dest_calendar_id
       JOIN accounts a ON a.id = d.account_id
     WHERE p.user_id = ? AND p.enabled = 1`,
    userId,
  );
  let cats: ReturnType<typeof categoryContext> | undefined;
  for (const p of policies) {
    // Rule 14: copies for events that end after now and start within 12 months.
    const events = all<SourceEvent>(
      db,
      "SELECT * FROM events WHERE calendar_id = ? AND end_ms > ? AND start_ms < ?",
      p.source_calendar_id,
      now,
      now + MIRROR_WINDOW,
    );
    // Rule 17: the destination's address (its calendar id, or the email of a primary calendar).
    const destination = [p.dest_provider_id, p.dest_email ?? ""].map((a) => a.toLowerCase());
    const horizon = Math.max(now, ...events.map((e) => e.end_ms));
    const work = workHours ? hoursToTimeSet(workHours, zone, now, horizon) : null;
    for (const e of events) {
      const props = JSON.parse(e.private_props) as Record<string, string>;
      // No chaining: copies and other managed events are never copied again.
      if (props[MANAGED_PROP] === "1") continue;
      const tagged = { title: e.summary, description: e.description };
      if (hasTag(tagged, TAG_NOSYNC)) continue;
      const attendees = JSON.parse(e.attendees) as string[];
      if (attendees.some((a) => destination.includes(a.toLowerCase()))) continue;
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
      // Rule 21.1: an event the provider made from an email (Gmail) is busy.
      if (e.event_type === "fromGmail") busy = true;
      // Rule 21.2 applies to meetings the owner organizes without being an attendee.
      else if (e.attendee_count > 0 && e.organizer_self && e.self_response === null) busy = true;
      else if (e.self_response === "accepted" || e.self_response === "tentative") busy = true;
      else if (e.self_response === "needsAction") busy = p.no_reply_busy === 1;
      else {
        busy = e.busy === 1;
        fromSource = true;
      }
      if (fromSource && !busy && (p.visibility === "label_only" || p.visibility === "busy_only"))
        continue;
      const details = p.visibility === "details_private" || p.visibility === "details_default";
      let title = e.summary;
      if (p.visibility === "busy_only") title = "Busy";
      else if (!details) {
        cats ??= categoryContext(db, userId);
        const category = categoryOf(
          {
            title: e.summary,
            description: e.description,
            start: e.start_ms,
            end: e.end_ms,
            eventType: e.event_type,
            attendees,
            managedKind: null,
            personalCalendar: false,
            manual: cats.manual.get(`${e.calendar_id}:${e.event_id}`) ?? null,
          },
          cats.userEmail,
        );
        title = copyLabel(category, p.calendar_type);
      }
      out.push({
        key: mirrorKey(p.id, e.event_id),
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
