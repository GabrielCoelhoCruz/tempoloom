// Meeting checks (docs/specs/automations-meeting-quality.md): issues computed
// from the event cache each time they are read, so an issue resolves as soon
// as its condition ends (rule 5) and a disabled check closes its issues
// (rule 2). Only ignores are stored (rule 3). Checks never change an event (rule 7).
import { hasVideo } from "../shared/meeting-checks.ts";
import { DAY } from "../shared/time.ts";
import { all, type Db, one } from "./db.ts";
import { type CheckId, getPrefs } from "./meeting-prefs.ts";
import { externalEvents } from "./planner/events.ts";
import { instanceUser } from "./planner/meetings.ts";
import { domainOf } from "./teams.ts";

/** Proposed horizon: events that start in the next 7 days. */
export const HORIZON = 7 * DAY;

export interface CompanyConditions {
  minAttendees?: number;
  descriptionEmpty?: boolean;
  noVideoLink?: boolean;
  externalGuests?: boolean;
  longerThanMinutes?: number;
  titleContains?: string;
}

export interface CompanyCheck {
  id: string;
  name: string;
  conditions: CompanyConditions;
  enabled: boolean;
}

export interface Issue {
  checkId: CheckId | "company";
  /** The id ignores use: the check id, or `company:<id>`. */
  ignoreId: string;
  eventKey: string;
  seriesId: string | null;
  title: string;
  start: number;
  end: number;
  message: string;
  company?: { id: string; name: string };
  /** Agenda drafts: the staged text (library entry 4). */
  draft?: string;
}

interface Ev {
  key: string;
  calendarId: string;
  eventId: string;
  seriesId: string | null;
  title: string;
  description: string;
  location: string;
  conference: string;
  start: number;
  end: number;
  allDay: boolean;
  busy: boolean;
  selfResponse: string | null;
  organizerSelf: boolean;
  /** Other people on the event (not the user). */
  others: string[];
  responses: Record<string, string>;
  /** Managed by Tempoloom: its kind (task, habit, meeting, ...), or null. */
  managed: string | null;
  locked: boolean;
  booking: boolean;
}

/** A street address: two or more commas, as buffers-travel.md reads it. */
const isAddress = (location: string) => (location.match(/,/g) ?? []).length >= 2;

function eventsOf(db: Db, userId: string, from: number, to: number): Ev[] {
  const email =
    one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email ?? "";
  const managed = new Map(
    all<{ calendar_id: string; event_id: string; kind: string; locked: number }>(
      db,
      "SELECT calendar_id, event_id, kind, locked FROM managed_events WHERE user_id = ? AND event_id IS NOT NULL",
      userId,
    ).map((m) => [`${m.calendar_id}:${m.event_id}`, m]),
  );
  return all<{
    calendar_id: string;
    event_id: string;
    recurring_id: string | null;
    summary: string;
    description: string;
    location: string;
    conference: string;
    start_ms: number;
    end_ms: number;
    all_day: number;
    busy: number;
    self_response: string | null;
    organizer_self: number;
    attendees: string;
    responses: string;
    private_props: string;
  }>(
    db,
    `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?
     ORDER BY e.start_ms, e.event_id`,
    userId,
    from,
    to,
  ).map((e) => {
    const key = `${e.calendar_id}:${e.event_id}`;
    const props = JSON.parse(e.private_props) as Record<string, string>;
    const m = managed.get(key);
    return {
      key,
      calendarId: e.calendar_id,
      eventId: e.event_id,
      seriesId: e.recurring_id,
      title: e.summary,
      description: e.description,
      location: e.location,
      conference: e.conference,
      start: e.start_ms,
      end: e.end_ms,
      allDay: e.all_day === 1,
      busy: e.busy === 1,
      selfResponse: e.self_response,
      organizerSelf: e.organizer_self === 1,
      others: (JSON.parse(e.attendees) as string[]).filter((a) => a !== email.toLowerCase()),
      responses: JSON.parse(e.responses) as Record<string, string>,
      managed: props.tl === "1" ? (m?.kind ?? "meeting") : null,
      locked: m?.locked === 1,
      booking: props.tl_booking === "1",
    };
  });
}

/** The `conflict` check: a commitment is organized or accepted, booked, or a locked managed event. */
function commitment(e: Ev): boolean {
  if (!e.busy || e.allDay || e.selfResponse === "declined") return false;
  if (e.booking) return true;
  if (e.managed) return e.locked && e.managed !== "mirror";
  return e.organizerSelf || e.selfResponse === "accepted";
}

/** A meeting the user takes part in: other people, timed, not declined, not a mirror copy. */
const meeting = (e: Ev) =>
  e.others.length > 0 &&
  !e.allDay &&
  e.selfResponse !== "declined" &&
  (e.managed === null || e.managed === "meeting");

export function agendaDraft(e: { title: string; others: string[] }): string {
  return [
    `Agenda: ${e.title}`,
    "1. Goal of the meeting",
    "2. Updates",
    "3. Decisions and next steps",
    `Guests: ${e.others.join(", ")}`,
  ].join("\n");
}

/** The company checks of the user's team (rules 8-11). */
export function companyChecks(db: Db, userId: string): CompanyCheck[] {
  return all<{ id: string; name: string; conditions: string; enabled: number }>(
    db,
    `SELECT c.id, c.name, c.conditions, c.enabled FROM company_checks c
       JOIN team_members m ON m.team_id = c.team_id WHERE m.user_id = ? ORDER BY c.created_at`,
    userId,
  ).map((c) => ({
    id: c.id,
    name: c.name,
    conditions: JSON.parse(c.conditions) as CompanyConditions,
    enabled: c.enabled === 1,
  }));
}

function companyFails(c: CompanyConditions, e: Ev, teamDomain: string): boolean {
  const people = e.others.length + 1;
  if (c.minAttendees !== undefined && people < c.minAttendees) return false;
  if (c.descriptionEmpty && e.description.trim() !== "") return false;
  if (c.noVideoLink && hasVideo(e)) return false;
  if (c.externalGuests && !e.others.some((o) => domainOf(o) !== teamDomain)) return false;
  if (c.longerThanMinutes !== undefined && e.end - e.start <= c.longerThanMinutes * 60_000)
    return false;
  if (c.titleContains && !e.title.toLowerCase().includes(c.titleContains.toLowerCase()))
    return false;
  return true;
}

/** Every issue of the user's meetings in the horizon, ignored ones included. */
export function evaluate(db: Db, userId: string, now: number, to = now + HORIZON): Issue[] {
  const prefs = getPrefs(db, userId);
  const on = prefs.checks;
  const events = eventsOf(db, userId, now, to).filter((e) => e.start >= now);
  const out: Issue[] = [];
  const base = (e: Ev) => ({
    eventKey: e.key,
    seriesId: e.seriesId,
    title: e.title,
    start: e.start,
    end: e.end,
  });

  if (on.conflict) {
    const list = events.filter(commitment);
    for (let i = 0; i < list.length; i++) {
      const a = list[i] as Ev;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j] as Ev;
        if (b.start >= a.end) break;
        if (Math.min(a.end, b.end) - Math.max(a.start, b.start) < 60_000) continue;
        out.push({
          ...base(a),
          checkId: "conflict",
          ignoreId: "conflict",
          message: `Overlaps with "${b.title}"`,
        });
      }
    }
  }

  for (const e of events.filter(meeting)) {
    if (on.attendee_availability && e.organizerSelf) {
      for (const who of e.others) {
        if (e.responses[who] === "declined") {
          out.push({
            ...base(e),
            checkId: "attendee_availability",
            ignoreId: "attendee_availability",
            message: `${who} declined`,
          });
          continue;
        }
        const user = instanceUser(db, who);
        if (!user || user.id === userId) continue;
        const busy = externalEvents(db, user.id, e.start, e.end).some(
          (x) =>
            x.busy &&
            !x.allDay &&
            x.selfResponse !== "declined" &&
            (x.organizerSelf || x.selfResponse === "accepted" || x.selfResponse === "tentative") &&
            !(x.title === e.title && x.start === e.start && x.end === e.end),
        );
        if (busy)
          out.push({
            ...base(e),
            checkId: "attendee_availability",
            ignoreId: "attendee_availability",
            message: `${who} is not free`,
          });
      }
    }
    if (on.rsvp_reminder && !e.organizerSelf && e.selfResponse === "needsAction")
      out.push({
        ...base(e),
        checkId: "rsvp_reminder",
        ignoreId: "rsvp_reminder",
        message: "You have not answered this invitation",
      });
    if (on.video_link && !hasVideo(e) && !isAddress(e.location))
      out.push({
        ...base(e),
        checkId: "video_link",
        ignoreId: "video_link",
        message: "No video link",
      });
    if (on.agenda && e.organizerSelf && e.managed === null && e.description.trim() === "")
      out.push({
        ...base(e),
        checkId: "agenda",
        ignoreId: "agenda",
        message: "No agenda",
        draft: agendaDraft(e),
      });
  }

  // Company checks raise their issue only for the meeting's organizer (rule 10).
  const company = companyChecks(db, userId).filter((c) => c.enabled);
  if (company.length > 0) {
    const teamDomain =
      one<{ domain: string }>(
        db,
        "SELECT t.domain FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ?",
        userId,
      )?.domain ?? "";
    for (const e of events.filter((x) => meeting(x) && x.organizerSelf)) {
      for (const c of company) {
        if (!companyFails(c.conditions, e, teamDomain)) continue;
        out.push({
          ...base(e),
          checkId: "company",
          ignoreId: `company:${c.id}`,
          message: c.name,
          company: { id: c.id, name: c.name },
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.checkId.localeCompare(b.checkId));
}

/**
 * Open issues: the ones the user has not ignored for the event or its series
 * (rule 3), of events that start before `to` (default: the 7-day horizon).
 */
export function openIssues(db: Db, userId: string, now: number, to = now + HORIZON): Issue[] {
  const ignores = new Set(
    all<{ check_id: string; scope: string; target: string }>(
      db,
      "SELECT check_id, scope, target FROM meeting_issue_ignores WHERE user_id = ?",
      userId,
    ).map((i) => `${i.check_id}\n${i.scope}\n${i.target}`),
  );
  return evaluate(db, userId, now, to).filter(
    (i) =>
      !ignores.has(`${i.ignoreId}\nevent\n${i.eventKey}`) &&
      !(i.seriesId && ignores.has(`${i.ignoreId}\nseries\n${i.seriesId}`)),
  );
}
