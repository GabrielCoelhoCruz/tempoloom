// Look up one event (docs/specs/support-troubleshooting.md rules 7-12): what
// Tempoloom knows about an event, found by its link or id, and the change log
// of Tempoloom's writes to it.
import { hasTag, tagText } from "../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../scheduler/hours.ts";
import { changesOf } from "./change-log.ts";
import { all, type Db, one } from "./db.ts";
import { TAG_NOSYNC } from "./planner/mirror.ts";
import { MANAGED_PROP } from "./planner/push.ts";
import { when, zoneOf } from "./preview.ts";

export type LookupError = "unreadable" | "unknown_calendar" | "not_found";

interface CalendarRow {
  id: string;
  name: string;
  provider_id: string;
  synced_at: number | null;
  email: string;
  provider: string;
  status: string;
}

interface EventRow {
  calendar_id: string;
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
  rsvp_note: string;
}

interface PolicyRow {
  id: string;
  source_calendar_id: string;
  dest_calendar_id: string;
  visibility: string;
  all_day_mode: string;
  copy_outside_work_hours: number;
  enabled: number;
}

function calendarsOf(db: Db, userId: string): CalendarRow[] {
  return all<CalendarRow>(
    db,
    `SELECT c.id, c.name, c.provider_id, c.synced_at, a.email, a.provider, a.status
     FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ?`,
    userId,
  );
}

/** The provider event id and calendar of a Google edit link: base64 of "<event id> <calendar id>". */
function googleLink(url: URL): { eventId: string; calendarId: string } | null {
  const eid =
    url.searchParams.get("eid") ??
    /\/(?:eventedit|event)\/([^/?#]+)/.exec(url.pathname)?.[1] ??
    null;
  if (!eid) return null;
  const text = Buffer.from(eid.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const [eventId, calendar] = text.split(" ");
  if (!eventId || !calendar || !/^[\w@.-]+$/.test(calendar)) return null;
  // Google shortens the calendar of a gmail.com account in the link.
  return {
    eventId,
    calendarId: calendar.endsWith("@m") ? `${calendar.slice(0, -2)}@gmail.com` : calendar,
  };
}

/** Finds the event behind a link or an id among the user's calendars. */
function find(
  db: Db,
  userId: string,
  q: string,
): { event: EventRow; calendar: CalendarRow } | { error: LookupError; calendar?: string } {
  const calendars = calendarsOf(db, userId);
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const eventIn = (calendarIds: string[], eventId: string) => {
    for (const id of calendarIds) {
      const e = one<EventRow>(
        db,
        "SELECT * FROM events WHERE calendar_id = ? AND event_id = ?",
        id,
        eventId,
      );
      if (e) return e;
    }
    return undefined;
  };
  const found = (e: EventRow | undefined) => {
    const calendar = e && byId.get(e.calendar_id);
    return e && calendar ? { event: e, calendar } : null;
  };

  let url: URL | null = null;
  try {
    url = /^https?:\/\//i.test(q) ? new URL(q) : null;
  } catch {
    return { error: "unreadable" };
  }
  if (url && /(^|\.)google\.com$/.test(url.hostname)) {
    const link = googleLink(url);
    if (!link) return { error: "unreadable" };
    const cals = calendars.filter((c) => c.provider_id === link.calendarId);
    if (cals.length === 0) return { error: "unknown_calendar" };
    return (
      found(
        eventIn(
          cals.map((c) => c.id),
          link.eventId,
        ),
      ) ?? {
        error: "not_found",
        calendar: cals[0]?.name ?? "",
      }
    );
  }
  if (url) {
    // A CalDAV event link is the address of the event inside its calendar collection.
    const href = url.toString();
    const cal = calendars.find(
      (c) => /^https?:\/\//.test(c.provider_id) && href.startsWith(c.provider_id),
    );
    if (!cal) {
      const servers = all<{ server_url: string | null }>(
        db,
        "SELECT server_url FROM accounts WHERE user_id = ? AND provider = 'caldav'",
        userId,
      );
      const known = servers.some((s) => s.server_url && new URL(s.server_url).host === url.host);
      return { error: known ? "unknown_calendar" : "unreadable" };
    }
    return found(eventIn([cal.id], href)) ?? { error: "not_found", calendar: cal.name };
  }
  // An event id: a provider id, a CalDAV object name, or a planner id.
  const ids = calendars.map((c) => c.id);
  const direct = found(eventIn(ids, q));
  if (direct) return direct;
  const marks = ids.map(() => "?").join(",");
  if (ids.length > 0) {
    const suffix = one<EventRow>(
      db,
      `SELECT * FROM events WHERE calendar_id IN (${marks}) AND (event_id LIKE ? OR event_id LIKE ?) LIMIT 1`,
      ...ids,
      `%/${q}`,
      `%/${q}.ics`,
    );
    const s = found(suffix);
    if (s) return s;
  }
  const managed = one<{ calendar_id: string; event_id: string }>(
    db,
    "SELECT calendar_id, event_id FROM managed_events WHERE id = ? AND user_id = ? AND event_id IS NOT NULL",
    q,
    userId,
  );
  if (managed) {
    const m = found(eventIn([managed.calendar_id], managed.event_id));
    if (m) return m;
  }
  return { error: "not_found" };
}

const TITLES: Record<string, string> = {
  task: "tasks",
  habit: "habits",
  focus: "focus_goals",
  buffer: "buffers",
  meeting: "meetings",
};
const KIND_NAMES: Record<string, string> = {
  task: "task",
  habit: "habit",
  focus: "focus time",
  buffer: "buffer",
  meeting: "flexible meeting",
};

/** Why a policy did not copy a source event: the copy rules of planner/mirror.ts, in words. */
function skipReason(db: Db, userId: string, p: PolicyRow, e: EventRow, now: number): string {
  if (!p.enabled) return "the mirroring is off";
  if (e.end_ms <= now) return "the event is over; only future events get copies";
  if (hasTag(tagText(e), TAG_NOSYNC)) return "the event has #tl_nosync";
  if (e.self_response === "declined") return "you declined it";
  if (e.all_day && p.all_day_mode === "none") return "all-day events are not copied";
  if (e.all_day && p.all_day_mode === "busy_only" && !e.busy) return "the all-day event is free";
  if (!p.copy_outside_work_hours) {
    const work = one<{ weekly: string }>(
      db,
      "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
      userId,
    );
    const set = work
      ? hoursToTimeSet(
          JSON.parse(work.weekly) as WeeklyHours,
          zoneOf(db, userId),
          e.start_ms,
          e.end_ms,
        )
      : null;
    if (set && set.total() === 0) return "the event is outside your work hours";
  }
  const fromSource =
    !(e.attendee_count > 0 && e.organizer_self && e.self_response === null) &&
    e.self_response !== "accepted" &&
    e.self_response !== "tentative" &&
    e.self_response !== "needsAction";
  if (fromSource && !e.busy && (p.visibility === "label_only" || p.visibility === "busy_only"))
    return "the event is free, and this mirroring copies only busy time";
  return "no copy yet; the next sync writes it";
}

export function lookupEvent(db: Db, userId: string, q: string, now: number) {
  const hit = find(db, userId, q.trim());
  if ("error" in hit) return hit;
  const { event: e, calendar } = hit;
  const zone = zoneOf(db, userId);
  const names = new Map(calendarsOf(db, userId).map((c) => [c.id, c.name]));
  const policyName = (p: PolicyRow) =>
    `${names.get(p.source_calendar_id) ?? "?"} → ${names.get(p.dest_calendar_id) ?? "?"}`;
  const managed = one<{ key: string; kind: string; source_id: string; locked: number }>(
    db,
    "SELECT key, kind, source_id, locked FROM managed_events WHERE user_id = ? AND calendar_id = ? AND event_id = ?",
    userId,
    e.calendar_id,
    e.event_id,
  );
  let item: { kind: string; title: string; locked: boolean } | null = null;
  let copy: { policy: string; source: { title: string; calendar: string } | null } | null = null;
  if (managed?.kind === "mirror") {
    const policy = one<PolicyRow>(
      db,
      "SELECT * FROM mirror_policies WHERE id = ? AND user_id = ?",
      managed.source_id,
      userId,
    );
    const sourceId = managed.key.slice(`mirror:${managed.source_id}:`.length);
    const source = policy
      ? one<{ summary: string }>(
          db,
          "SELECT summary FROM events WHERE calendar_id = ? AND event_id = ?",
          policy.source_calendar_id,
          sourceId,
        )
      : undefined;
    copy = {
      policy: policy ? policyName(policy) : "a mirroring that was deleted",
      source:
        source && policy
          ? { title: source.summary, calendar: names.get(policy.source_calendar_id) ?? "" }
          : null,
    };
  } else if (managed) {
    const table = TITLES[managed.kind];
    const row = table
      ? one<{ title: string }>(db, `SELECT title FROM ${table} WHERE id = ?`, managed.source_id)
      : undefined;
    item = {
      kind: KIND_NAMES[managed.kind] ?? managed.kind,
      title: row?.title ?? "(deleted)",
      locked: managed.locked === 1,
    };
  }
  // A source event: each mirroring of its calendar copied it, or says why not (rule 9).
  const own = (JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] === "1";
  const policies = own
    ? []
    : all<PolicyRow>(
        db,
        "SELECT * FROM mirror_policies WHERE user_id = ? AND source_calendar_id = ? ORDER BY created_at",
        userId,
        e.calendar_id,
      ).map((p) => {
        const copied = one(
          db,
          "SELECT 1 FROM managed_events WHERE user_id = ? AND key = ? AND event_id IS NOT NULL",
          userId,
          `mirror:${p.id}:${e.event_id}`,
        );
        return {
          name: policyName(p),
          decision: copied ? "copied" : "skipped",
          reason: copied ? "" : skipReason(db, userId, p, e, now),
        };
      });
  return {
    event: {
      title: e.summary,
      when: e.all_day ? "all day" : when(zone, e.start_ms, e.end_ms),
    },
    calendar: {
      name: calendar.name,
      account: calendar.email,
      lastRead: calendar.synced_at === null ? null : when(zone, calendar.synced_at),
      lastError:
        calendar.status === "reauth_required" ? "The account needs you to sign in again" : null,
    },
    item,
    copy,
    policies,
    changes: changesOf(db, userId, e.calendar_id, e.event_id, managed?.key ?? null).map((c) => ({
      at: when(zone, c.at),
      action: c.action,
      reason: c.reason,
      title: c.title,
      range: c.start !== null && c.end !== null ? when(zone, c.start, c.end) : "",
      actor: c.actor,
    })),
  };
}
