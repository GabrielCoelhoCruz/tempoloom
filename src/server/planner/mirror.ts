// Calendar mirroring: which source events get a copy, and how the copy looks
// (docs/specs/sync-calendar-mirroring.md rules 14-32).
import { hasTag, tagText } from "../../scheduler/blocking.ts";
import { type Category, categoryOf } from "../../scheduler/categories.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import { utcToLocal } from "../../shared/time.ts";
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
  rsvp_note: string;
}

/**
 * A policy is active while the accounts of its source and destination are
 * connected (accounts-login-emails-permissions.md rule 16). A paused policy
 * makes no copies and keeps the copies it has. Needs the policy as `p`.
 */
export const ACTIVE = `NOT EXISTS (SELECT 1 FROM calendars c JOIN accounts x ON x.id = c.account_id
  WHERE c.id IN (p.source_calendar_id, p.dest_calendar_id) AND x.status <> 'ok')`;

/** Provider visibility of a copy by the policy's privacy option (rule 26). */
const VISIBILITY = {
  label_only: "public",
  busy_only: undefined,
  details_private: "private",
  details_default: undefined,
} as const;

/** A travel or airport buffer of this run as a source event; its key stands for the event id. */
function bufferSource(d: DesiredEvent): SourceEvent {
  return {
    event_id: d.key,
    summary: d.title,
    description: d.description,
    start_ms: d.start,
    end_ms: d.end,
    all_day: 0,
    busy: d.busy ? 1 : 0,
    self_response: null,
    organizer_self: 1,
    attendee_count: 0,
    private_props: "{}",
    attendees: "[]",
    event_type: "default",
    location: d.location ?? "",
    calendar_id: d.calendarId,
    rsvp_note: "",
  };
}

/**
 * The copies every enabled policy of the user wants, as desired managed events.
 * Managed events are never copied (no chaining), except the travel and airport
 * buffers of this run (buffers-travel.md outputs): their copies follow the
 * policy's visibility, and come with the buffers in the same run.
 * `noReplyBusy` is the account setting for events the owner has not answered
 * (the account-level setting `no_reply_copies`, default free).
 */
export function mirrorCopies(
  db: Db,
  userId: string,
  zone: string,
  now: number,
  workHours: WeeklyHours | null,
  noReplyBusy = false,
  travelBuffers: DesiredEvent[] = [],
): DesiredEvent[] {
  const out: DesiredEvent[] = [];
  const policies = all<Policy>(
    db,
    `SELECT p.*, d.provider_id AS dest_provider_id,
       CASE WHEN d.is_primary = 1 THEN a.email END AS dest_email
     FROM mirror_policies p JOIN calendars d ON d.id = p.dest_calendar_id
       JOIN accounts a ON a.id = d.account_id
     WHERE p.user_id = ? AND p.enabled = 1 AND ${ACTIVE}`,
    userId,
  );
  let cats: ReturnType<typeof categoryContext> | undefined;
  for (const p of policies) {
    // Rule 14: copies for events that end after now and start within 12 months.
    const buffers = travelBuffers
      .filter((d) => d.calendarId === p.source_calendar_id && d.end > now)
      .map(bufferSource);
    const travel = new Set(buffers.map((b) => b.event_id));
    const events = [
      ...all<SourceEvent>(
        db,
        "SELECT * FROM events WHERE calendar_id = ? AND end_ms > ? AND start_ms < ?",
        p.source_calendar_id,
        now,
        now + MIRROR_WINDOW,
      ).filter(
        (e) => (JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] !== "1",
      ),
      ...buffers,
    ];
    // Rule 17: the destination's address (its calendar id, or the email of a primary calendar).
    const destination = [p.dest_provider_id, p.dest_email ?? ""].map((a) => a.toLowerCase());
    const horizon = Math.max(now, ...events.map((e) => e.end_ms));
    const work = workHours ? hoursToTimeSet(workHours, zone, now, horizon) : null;
    for (const e of events) {
      if (hasTag(tagText(e), TAG_NOSYNC)) continue;
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
      else if (e.self_response === "needsAction") busy = noReplyBusy;
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
        const category: Category = travel.has(e.event_id)
          ? "travel"
          : categoryOf(
              {
                title: e.summary,
                description: e.description,
                rsvpNote: e.rsvp_note,
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
        ...(details && e.location ? { location: e.location } : {}),
        ...(VISIBILITY[p.visibility] ? { visibility: VISIBILITY[p.visibility] } : {}),
        // Rule 24: a copy of an all-day event is an all-day event.
        ...(e.all_day
          ? {
              allDayDates: {
                start: utcToLocal(zone, e.start_ms).date,
                end: utcToLocal(zone, e.end_ms).date,
              },
            }
          : {}),
      });
    }
  }
  return out;
}
