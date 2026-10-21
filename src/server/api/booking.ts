// Booking links: the settings of owners and co-organizers (under /api) and the
// public pages' API (under /pub, no session). Specs: booking-links*.md.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  type Booking,
  type CalendarItem,
  type OfferedTime,
  type Person,
  type TeamRules,
  teamOffers,
} from "../../scheduler/availability.ts";
import { hasTag, TAG_FREE, tagText } from "../../scheduler/blocking.ts";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import type { ExternalEvent, Level } from "../../scheduler/model.ts";
import { addLocalDays, isValidTimeZone } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import {
  bookedLocation,
  defaultLocation,
  type LocationOption,
  locationsOf,
  locationText,
  needsTravel,
} from "../booking-location.ts";
import { type Answer, type BookingChange, notifyBooking } from "../booking-mail.ts";
import {
  assign,
  bookingHolds,
  hoursOf,
  type LinkPerson,
  linkPeople,
  type Party,
  recoveryMinutes,
  travelMinutes,
  writeBookingEvents,
} from "../booking-team.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { createItemHours, dropItemHours, itemHoursSchema } from "../item-hours.ts";
import { limitRefusal } from "../limits.ts";
import type { Mailer } from "../mail.ts";
import { getPrefs } from "../meeting-prefs.ts";
import { MANAGED_PROP } from "../planner/push.ts";
import { writeCalendar } from "../planner/replan.ts";
import { getSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";
import { membership, sameTeam } from "../teams.ts";
import { planningZone } from "../travel.ts";
import { type CustomData, customData, type WebhookType } from "../webhooks.ts";
import { type Branding, brandingFor, resolveLinkBranding } from "./branding.ts";

export interface LinkRow {
  id: string;
  user_id: string;
  slug: string;
  hidden: number;
  title: string;
  description: string;
  title_template: string;
  durations: string;
  level: Level;
  hours_set_id: string | null;
  notice_minutes: number;
  range_end_days: number;
  buffer_before: number;
  buffer_after: number;
  max_per_day: number | null;
  max_per_week: number | null;
  location: string;
  use_recovery_buffer: number;
  branding: Branding;
  questions: string;
  reminder_enabled: number;
  reminder_hours: number;
  reminder_message: string;
  reminder_saved_at: number;
  redirect_url: string | null;
  default_duration: number | null;
  group_id: string | null;
  source_id: string | null;
  invitee_name: string;
  invitee_email: string;
  created_at: number;
  /** Last bookable date (YYYY-MM-DD); it replaces the rolling days when set. */
  range_end_date: string | null;
  /** The owner's calendar for booked events; null: the main calendar. */
  calendar_id: string | null;
  use_travel_buffer: number;
  /** JSON list of location options; the first is the default. */
  locations: string;
}

interface BookingRow {
  id: string;
  link_id: string | null;
  user_id: string;
  calendar_id: string | null;
  event_id: string | null;
  start_ms: number;
  end_ms: number;
  name: string;
  email: string;
  message: string;
  status: "booked" | "cancelled";
  created_at: number;
  custom_data: string;
  host_id: string | null;
  assignee_id: string | null;
  answers: string;
  time_zone: string;
  cc: string;
  location: string | null;
}

const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const hash = (t: string) => createHash("sha256").update(t).digest("base64url");
const MAX_SPAN = 15 * 86_400_000;

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "link"
  );
}

/** A screening question (booking-links.md, question record). */
export interface Question {
  label: string;
  type: "singleLine" | "multiLine" | "choice";
  options: string[];
  required: boolean;
}

const question = z
  .object({
    label: z.string().trim().min(1).max(300),
    type: z.enum(["singleLine", "multiLine", "choice"]),
    options: z.array(z.string().trim().min(1).max(200)).max(20),
    required: z.boolean(),
  })
  .refine((q) => q.type !== "choice" || q.options.length > 0, "A choice question needs choices.");

/** Page slugs with another meaning in /book/... URLs. */
const RESERVED = new Set(["o", "manage", "embed"]);

/**
 * True when a page slug is in use: by another user's booking page, another link
 * group, or the URL scheme. Page and group slugs are unique on the instance
 * (booking-links-sharing.md edge case 4).
 */
export function pageSlugTaken(
  db: Db,
  slug: string,
  mine: { userId?: string; groupId?: string },
): boolean {
  if (RESERVED.has(slug)) return true;
  const page = one<{ user_id: string }>(
    db,
    "SELECT user_id FROM booking_pages WHERE slug = ?",
    slug,
  );
  if (page && page.user_id !== mine.userId) return true;
  const group = one<{ id: string }>(db, "SELECT id FROM booking_groups WHERE slug = ?", slug);
  return group !== undefined && group.id !== mine.groupId;
}

/** The page columns of a link: main page, hidden, or a link group of the owner. */
function pageColumns(
  db: Db,
  ownerId: string,
  b: { page?: string | undefined; hidden?: boolean | undefined },
): { hidden: number; group_id: string | null } | undefined {
  if (b.page === undefined) {
    return b.hidden === undefined ? undefined : { hidden: b.hidden ? 1 : 0, group_id: null };
  }
  if (b.page === "main") return { hidden: 0, group_id: null };
  if (b.page === "hidden") return { hidden: 1, group_id: null };
  if (!one(db, "SELECT 1 FROM booking_groups WHERE id = ? AND user_id = ?", b.page, ownerId))
    invalid("unknown_page");
  return { hidden: 0, group_id: b.page };
}

/** The slug of the page a link is on: its group's, or the owner's main page. */
export function linkPageSlug(
  db: Db,
  link: { user_id: string; group_id: string | null; source_id: string | null },
) {
  // One-off links live at /book/o/<slug> (sharing rule 15).
  if (link.source_id) return "o";
  return link.group_id
    ? (one<{ slug: string }>(db, "SELECT slug FROM booking_groups WHERE id = ?", link.group_id)
        ?.slug ?? null)
    : (one<{ slug: string }>(db, "SELECT slug FROM booking_pages WHERE user_id = ?", link.user_id)
        ?.slug ?? null);
}

const linkInput = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  slug: z.string().regex(slugRe).optional(),
  hidden: z.boolean().optional(),
  /** "main", "hidden" or the id of one of the owner's link groups (sharing rule 2). */
  page: z.string().max(64).optional(),
  /** The event title, with {title}, {organizer} and {attendee}. */
  titleTemplate: z.string().trim().min(1).max(200).optional(),
  /** One-off links: the invitee the booking page is prefilled with (sharing rule 9). */
  inviteeName: z.string().trim().max(200).optional(),
  inviteeEmail: z.union([z.literal(""), z.email()]).optional(),
  durations: z.array(z.number().int().min(5).max(480).multipleOf(5)).min(1).max(3),
  level: z.number().int().min(1).max(4).optional(),
  hoursSetId: z.string().nullable().optional(),
  noticeMinutes: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60)
    .optional(),
  rangeEndDays: z.number().int().min(0).max(100).optional(),
  bufferBefore: z.number().int().min(0).max(120).optional(),
  bufferAfter: z.number().int().min(0).max(120).optional(),
  maxPerDay: z.number().int().min(1).max(50).nullable().optional(),
  maxPerWeek: z.number().int().min(1).max(200).nullable().optional(),
  questions: z.array(question).max(10).optional(),
  reminder: z
    .object({
      enabled: z.boolean(),
      hoursBefore: z.number().int().min(1).max(168),
      message: z.string().max(1024),
    })
    .optional(),
  /** Must start with https:// (edge case 8); "" or null removes it. */
  redirectUrl: z.string().max(2000).nullable().optional(),
  defaultDuration: z.number().int().nullable().optional(),
  /** A fixed last date instead of rolling days; null goes back to rolling days. */
  rangeEndDate: z.iso.date().nullable().optional(),
  /** One of the owner's writable calendars; null: the main calendar. */
  calendarId: z.string().nullable().optional(),
  useTravelBuffer: z.boolean().optional(),
  /** Up to 10 options; the first is the default. */
  locations: z
    .array(
      z.object({
        kind: z.enum(["address", "phone", "custom"]),
        value: z.string().trim().min(1).max(500),
      }),
    )
    .max(10)
    .optional(),
});

const BRANDINGS = ["sameAsGroup", "default", "none", "custom"] as const;

const linkChanges = linkInput.partial().extend({
  useRecoveryBuffer: z.boolean().optional(),
  branding: z.enum(BRANDINGS).optional(),
  /** `itemHours`: new item-specific hours for the person; `hoursSetId` is then ignored. */
  organizers: z
    .array(
      z.object({
        userId: z.string(),
        hoursSetId: z.string().nullable(),
        itemHours: itemHoursSchema.optional(),
        required: z.boolean(),
        isHost: z.boolean(),
      }),
    )
    .max(20)
    .optional(),
  pool: z
    .array(
      z.object({
        userId: z.string(),
        hoursSetId: z.string().nullable(),
        itemHours: itemHoursSchema.optional(),
        preferred: z.boolean(),
      }),
    )
    .max(50)
    .optional(),
});

const forbidden = (): never => {
  throw new HTTPException(403, { res: Response.json({ error: "forbidden" }, { status: 403 }) });
};
const invalid = (error: string): never => {
  throw new HTTPException(400, { res: Response.json({ error }, { status: 400 }) });
};

/** A redirect URL as stored: https only (booking-links.md edge case 8); empty removes it. */
function redirectValue(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const text = v?.trim() ?? "";
  if (!text) return null;
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {}
  if (url?.protocol !== "https:") invalid("redirect_https");
  return url?.toString() ?? null;
}

type Options = {
  [K in "questions" | "reminder" | "redirectUrl" | "defaultDuration" | "durations"]?:
    | z.infer<typeof linkInput>[K]
    | undefined;
};

/**
 * Columns for the booking page options of a link. The reminder setting records
 * when it changed: bookings made before get a reminder only if it is still
 * ahead then (booking-links.md rule 21).
 */
function optionColumns(
  b: Options,
  current: LinkRow | undefined,
  now: number,
): [string, string | number | null | undefined][] {
  const durations =
    b.durations ?? (current ? (JSON.parse(current.durations) as number[]) : undefined);
  let defaultDuration: number | null | undefined;
  if (b.defaultDuration !== undefined) {
    if (b.defaultDuration !== null && !durations?.includes(b.defaultDuration))
      invalid("default_duration");
    defaultDuration = b.defaultDuration;
  } else if (current?.default_duration && !durations?.includes(current.default_duration)) {
    // The old default is no longer one of the durations: the first one is the default again.
    defaultDuration = null;
  }
  const r = b.reminder;
  const changed =
    r !== undefined &&
    (!current ||
      current.reminder_enabled !== (r.enabled ? 1 : 0) ||
      current.reminder_hours !== r.hoursBefore ||
      current.reminder_message !== r.message);
  return [
    ["questions", b.questions && JSON.stringify(b.questions)],
    ["reminder_enabled", r === undefined ? undefined : r.enabled ? 1 : 0],
    ["reminder_hours", r?.hoursBefore],
    ["reminder_message", r?.message],
    ["reminder_saved_at", changed ? now : undefined],
    ["redirect_url", redirectValue(b.redirectUrl)],
    ["default_duration", defaultDuration],
  ];
}

/** Classifies the owner's events for availability (class table of the spec). */
export function calendarItems(db: Db, userId: string, from: number, to: number): CalendarItem[] {
  const items: CalendarItem[] = [];
  const lowered = new Map(
    all<{ calendar_id: string; target_id: string; level: Level }>(
      db,
      "SELECT calendar_id, target_id, level FROM external_levels WHERE user_id = ?",
      userId,
    ).map((x) => [`${x.calendar_id}:${x.target_id}`, x.level]),
  );
  for (const e of all<{
    calendar_id: string;
    event_id: string;
    recurring_id: string | null;
    summary: string;
    description: string;
    start_ms: number;
    end_ms: number;
    busy: number;
    event_type: string;
    self_response: ExternalEvent["selfResponse"];
    organizer_self: number;
    private_props: string;
    rsvp_note: string;
    main: number;
  }>(
    db,
    `SELECT e.*, (a.is_main = 1 AND c.is_primary = 1) AS main
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?`,
    userId,
    from,
    to,
  )) {
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1") continue;
    const span = { start: e.start_ms, end: e.end_ms, title: e.summary };
    if (props.tl_booking === "1") {
      items.push({
        ...span,
        cls: "booked",
        ...(props.tl_booking_id ? { bookingId: props.tl_booking_id } : {}),
      });
    } else if (!e.busy || e.self_response === "declined") {
      // Free events (with or without #tl_busy) and declined invitations never block a link.
      items.push({ ...span, cls: "free" });
    } else if (hasTag(tagText(e), TAG_FREE)) {
      // No-meeting time is closed to every link, whatever its priority (events-tags.md rule 4).
      items.push({ ...span, cls: "fixed" });
    } else {
      // Other busy events block, including unanswered invitations: a booking is final.
      // A level the user lowered lets higher-priority links offer the time (external priority rule 5).
      // Only events of the main calendar can have a lowered level (rule 4).
      const level =
        (e.main === 1
          ? (lowered.get(`${e.calendar_id}:${e.event_id}`) ??
            (e.recurring_id ? lowered.get(`${e.calendar_id}:${e.recurring_id}`) : undefined))
          : undefined) ?? 1;
      items.push(level > 1 ? { ...span, cls: "prioritized", level } : { ...span, cls: "fixed" });
    }
  }
  const levels = new Map<string, Level>();
  for (const t of all<{ id: string; level: Level }>(
    db,
    "SELECT id, level FROM tasks WHERE user_id = ?",
    userId,
  )) {
    levels.set(`task:${t.id}`, t.level);
  }
  for (const h of all<{ id: string; level: Level }>(
    db,
    "SELECT id, level FROM habits WHERE user_id = ?",
    userId,
  )) {
    levels.set(`habit:${h.id}`, h.level);
  }
  for (const b of all<{ id: string; level: Level }>(
    db,
    "SELECT id, level FROM buffers WHERE user_id = ?",
    userId,
  )) {
    levels.set(`buffer:${b.id}`, b.level);
  }
  // offer_to_booking_links=false: no link offers that focus time (focus-time.md rule 32).
  const hidden = new Set(
    all<{ id: string }>(
      db,
      "SELECT id FROM focus_goals WHERE user_id = ? AND offer_to_links = 0",
      userId,
    ).map((f) => f.id),
  );
  for (const m of all<{
    kind: string;
    source_id: string;
    start_ms: number;
    end_ms: number;
    busy: number;
    locked: number;
    title: string;
  }>(
    db,
    "SELECT kind, source_id, start_ms, end_ms, busy, locked, title FROM managed_events WHERE user_id = ? AND end_ms > ? AND start_ms < ?",
    userId,
    from,
    to,
  )) {
    const span = { start: m.start_ms, end: m.end_ms, title: m.title };
    if (m.locked || (m.kind === "focus" && hidden.has(m.source_id)))
      items.push({ ...span, cls: "fixed" });
    else if (!m.busy) items.push({ ...span, cls: "free" });
    else {
      // Placed focus time counts as P2 for booking links.
      const level = m.kind === "focus" ? 2 : (levels.get(`${m.kind}:${m.source_id}`) ?? 1);
      items.push({ ...span, cls: "prioritized", level });
    }
  }
  for (const h of bookingHolds(db, userId, from, to)) {
    items.push({ start: h.start, end: h.end, cls: "booked", bookingId: h.id, title: h.title });
  }
  return items;
}

function rulesFor(db: Db, link: LinkRow, duration: number): TeamRules {
  return {
    durationMinutes: duration,
    level: link.level,
    zone: planningZone(db, link.user_id),
    weekStart: getSettings(db, link.user_id).weekStart,
    noticeMinutes: link.notice_minutes,
    rangeEndDays: link.range_end_days,
    rangeEndDate: link.range_end_date,
    bufferBeforeMinutes: link.buffer_before,
    bufferAfterMinutes: link.buffer_after,
    maxPerDay: link.max_per_day,
    maxPerWeek: link.max_per_week,
  };
}

const zoneOf = (db: Db, userId: string) =>
  one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", userId)?.time_zone ??
  "UTC";
const nameOf = (db: Db, userId: string) =>
  one<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", userId)?.name ?? "";

/** The people a link checks: required organizers and the pool, all in the owner's team. */
function linkTeam(db: Db, link: LinkRow): { people: LinkPerson[]; usable: boolean } {
  const people = linkPeople(db, link.id);
  const inTeam = (p: LinkPerson) => sameTeam(db, link.user_id, p.userId);
  // An organizer who left the team stops the link until the owner removes them
  // (booking-links edge case 3); pool members who left only drop out (team edge case 3).
  const usable = people.every((p) => p.kind === "pool" || inTeam(p));
  return { people: people.filter((p) => p.kind === "organizer" || inTeam(p)), usable };
}

/** What availability needs for one link and duration: rules, people and bookings. */
export function linkInputs(
  db: Db,
  link: LinkRow,
  duration: number,
  from: number,
  to: number,
  now: number,
  location: LocationOption | null = defaultLocation(link),
): { rules: TeamRules; required: Person[]; pool: Person[]; bookings: Booking[] } | null {
  const { people, usable } = linkTeam(db, link);
  if (!usable) return null;
  // A one-off link and its source share their limits (sharing rule 16).
  const family = link.source_id ?? link.id;
  const bookings = all<{ id: string; start_ms: number; end_ms: number }>(
    db,
    `SELECT id, start_ms, end_ms FROM bookings
     WHERE link_id IN (SELECT id FROM booking_links WHERE id = ? OR source_id = ?)
       AND status = 'booked' AND end_ms > ?`,
    family,
    family,
    now - 8 * 86_400_000,
  ).map((b) => ({ id: b.id, start: b.start_ms, end: b.end_ms }));
  // The booked meeting as the recovery buffer filters see it (availability rule 10).
  const organizers = people.filter((p) => p.kind === "organizer");
  const meeting: ExternalEvent = {
    id: "",
    start: from,
    end: from + duration * 60_000,
    allDay: false,
    busy: true,
    title: link.title,
    description: "",
    selfResponse: null,
    organizerSelf: true,
    attendeeCount: organizers.length + (organizers.length < people.length ? 1 : 0) + 1,
    location: locationText(location),
    eventType: "default",
    bookedViaLink: true,
  };
  const pad = (link.buffer_before + link.buffer_after + 240 + duration) * 60_000;
  const person = (p: LinkPerson): Person => ({
    id: p.userId,
    hours: hoursOf(db, p.userId, p.hoursSetId),
    // Hours follow a travel time zone on its dates (timezones-home-and-travel.md rule 3).
    zone: planningZone(db, p.userId),
    items: calendarItems(db, p.userId, from - pad, to + pad),
    recoveryMinutes: link.use_recovery_buffer ? recoveryMinutes(db, p.userId, meeting) : 0,
    ...(link.use_travel_buffer && needsTravel(location)
      ? travelMinutes(db, p.userId, meeting)
      : {}),
    startMinutes: getPrefs(db, p.userId).startMinutes,
  });
  return {
    rules: rulesFor(db, link, duration),
    required: organizers.filter((p) => p.required).map(person),
    pool: people.filter((p) => p.kind === "pool").map(person),
    bookings,
  };
}

/** Times of one link, each with the pool members who pass (round robin). */
export function linkTimes(
  db: Db,
  link: LinkRow,
  duration: number,
  from: number,
  to: number,
  now: number,
  rescheduling?: string,
  location?: LocationOption | null,
): OfferedTime[] {
  const inputs = linkInputs(db, link, duration, from, to, now, location);
  if (!inputs) return [];
  const { rules, required, pool, bookings } = inputs;
  return teamOffers(rules, required, pool, bookings, now, from, to, rescheduling);
}

function publicLink(link: LinkRow) {
  const durations = JSON.parse(link.durations) as number[];
  return {
    slug: link.slug,
    title: link.title,
    description: link.description,
    durations,
    defaultDuration:
      link.default_duration && durations.includes(link.default_duration)
        ? link.default_duration
        : (durations[0] ?? null),
    location: locationText(defaultLocation(link)),
    locations: locationsOf(link),
    questions: JSON.parse(link.questions) as Question[],
    redirectUrl: link.redirect_url,
    prefill:
      link.invitee_name || link.invitee_email
        ? { name: link.invitee_name, email: link.invitee_email }
        : null,
  };
}

/** The booker's answers, in question order; null when one is missing or not a choice. */
function checkAnswers(link: LinkRow, given: string[]): { answers: Answer[] } | { error: string } {
  const questions = JSON.parse(link.questions) as Question[];
  if (given.length > questions.length) return { error: "invalid_answer" };
  const answers: Answer[] = [];
  for (const [i, q] of questions.entries()) {
    const answer = (given[i] ?? "").trim();
    if (q.required && !answer) return { error: "answer_required" };
    if (q.type === "choice" && answer && !q.options.includes(answer))
      return { error: "invalid_answer" };
    answers.push({ question: q.label, answer });
  }
  return { answers };
}

/** Names the booker may see before confirming: organizers only, never the pool (team rule 15). */
function organizerNames(db: Db, link: LinkRow): string[] {
  return linkPeople(db, link.id)
    .filter((p) => p.kind === "organizer")
    .map((p) => nameOf(db, p.userId));
}

function eventTitle(link: LinkRow, organizer: string, attendee: string): string {
  return link.title_template
    .replaceAll("{organizer}", organizer)
    .replaceAll("{attendee}", attendee)
    .replaceAll("{title}", link.title);
}

interface PersonView {
  userId: string;
  name: string;
  email: string;
  hoursSetId: string | null;
  /** The ranges when `hoursSetId` is the person's item-specific hours on the link. */
  itemHours: WeeklyHours | null;
}

/** The ranges of an item-specific hours set, or null for a named set or none. */
function itemWeekly(db: Db, setId: string | null): WeeklyHours | null {
  const row =
    setId &&
    one<{ weekly: string }>(
      db,
      "SELECT weekly FROM hours_sets WHERE id = ? AND item_specific = 1",
      setId,
    );
  return row ? (JSON.parse(row.weekly) as WeeklyHours) : null;
}

/**
 * Why the link's calendar for booked events cannot take them, or null
 * (connected calendars rules 19, 22): its account was removed or is
 * disconnected, or the calendar is read-only. The link then takes no new
 * bookings until the owner picks another account; it does not fall back.
 */
export function targetProblem(db: Db, link: LinkRow): string | null {
  if (!link.calendar_id) return null;
  const c = one<{ email: string; status: string; writable: number }>(
    db,
    `SELECT a.email, a.status, c.writable FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE c.id = ? AND a.user_id = ?`,
    link.calendar_id,
    link.user_id,
  );
  const pick = "choose another account for booked events.";
  if (!c)
    return "Paused: the account for booked events was removed. Choose another account for booked events.";
  if (c.status !== "ok")
    return `Paused: ${c.email} is disconnected. Reconnect it on the Account page, or ${pick}`;
  if (!c.writable)
    return `Paused: Tempoloom cannot write to this calendar of ${c.email}. Please ${pick}`;
  return null;
}

/** A link as its owner and co-organizers see it, with its people. */
function linkView(db: Db, link: LinkRow, oneOffDays: number) {
  const user = (id: string) =>
    one<{ name: string; email: string }>(db, "SELECT name, email FROM users WHERE id = ?", id) ?? {
      name: "",
      email: "",
    };
  const people = linkPeople(db, link.id);
  const view = (p: LinkPerson): PersonView => ({
    userId: p.userId,
    ...user(p.userId),
    hoursSetId: p.hoursSetId,
    itemHours: itemWeekly(db, p.hoursSetId),
  });
  return {
    ...link,
    durations: JSON.parse(link.durations) as number[],
    questions: JSON.parse(link.questions) as Question[],
    locations: locationsOf(link),
    owner: { id: link.user_id, ...user(link.user_id) },
    page: link.group_id ?? (link.hidden ? "hidden" : "main"),
    pageSlug: linkPageSlug(db, link),
    expiresAt: oneOffExpiry(link, oneOffDays, zoneOf(db, link.user_id)),
    targetError: targetProblem(db, link),
    organizers: people
      .filter((p) => p.kind === "organizer")
      .map((p) => ({ ...view(p), required: p.required, isHost: p.isHost })),
    pool: people
      .filter((p) => p.kind === "pool")
      .map((p) => ({ ...view(p), preferred: p.preferred })),
  };
}

type Changes = z.infer<typeof linkChanges>;

/**
 * Team rules 1, 3, 9, 12 and 13: who may be on a link and in which role. A
 * person's hours are a named set of theirs, or the item-specific hours they
 * have on this link already (planning-hours.md, item-specific hours).
 */
function checkPeople(
  db: Db,
  link: LinkRow,
  organizers: NonNullable<Changes["organizers"]>,
  pool: NonNullable<Changes["pool"]>,
): void {
  const ownerId = link.user_id;
  const current = new Map(linkPeople(db, link.id).map((p) => [p.userId, p.hoursSetId]));
  const ids = [...organizers, ...pool].map((p) => p.userId);
  if (new Set(ids).size !== ids.length) invalid("duplicate_person");
  if (organizers.length === 0 && pool.length === 0) invalid("no_people");
  if (pool.length === 1) invalid("pool_too_small");
  const hosts = organizers.filter((o) => o.isHost);
  if (hosts.length !== (organizers.length > 0 ? 1 : 0)) invalid("one_host");
  if (hosts.some((h) => !h.required)) invalid("host_required");
  for (const p of [...organizers, ...pool]) {
    if (!sameTeam(db, ownerId, p.userId)) invalid("not_in_team");
    if (
      !p.itemHours &&
      p.hoursSetId &&
      p.hoursSetId !== current.get(p.userId) &&
      !one(
        db,
        "SELECT 1 FROM hours_sets WHERE id = ? AND user_id = ? AND item_specific = 0",
        p.hoursSetId,
        p.userId,
      )
    ) {
      invalid("unknown_hours");
    }
  }
}

export function bookingRoutes(db: Db, now: () => number, oneOffDays: number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/page", (c) => {
    const page = one<{ slug: string; branding: string }>(
      db,
      "SELECT slug, branding FROM booking_pages WHERE user_id = ?",
      c.get("user").id,
    );
    return c.json({ slug: page?.slug ?? null, branding: page?.branding ?? null });
  });

  /** Claims the user's booking page slug and creates the starter links (booking-links rules 1, 2). */
  r.post("/page", async (c) => {
    const user = c.get("user");
    const { slug } = await jsonBody(c, z.object({ slug: z.string().regex(slugRe) }));
    if (pageSlugTaken(db, slug, { userId: user.id })) return c.json({ error: "slug_taken" }, 409);
    // A new page copies the team's branding default (booking page rule 28).
    const teamDefault =
      one<{ mode: string }>(
        db,
        "SELECT b.mode FROM team_branding b JOIN team_members m ON m.team_id = b.team_id WHERE m.user_id = ?",
        user.id,
      )?.mode ?? "default";
    tx(db, () => {
      const had = one(db, "SELECT 1 FROM booking_pages WHERE user_id = ?", user.id);
      run(
        db,
        `INSERT INTO booking_pages (user_id, slug, created_at, branding) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET slug = excluded.slug`,
        user.id,
        slug,
        now(),
        teamDefault,
      );
      if (!had) {
        for (const [title, level, durations] of [
          ["Important meeting", 1, [30]],
          ["Quick meeting", 3, [15, 30]],
          ["Meeting", 2, [30, 60]],
        ] as const) {
          insertLink(user.id, { title, level, durations: [...durations] });
        }
      }
    });
    return c.json({ slug });
  });

  r.put("/page/branding", async (c) => {
    const { branding } = await jsonBody(
      c,
      z.object({ branding: z.enum(["default", "none", "custom"]) }),
    );
    run(db, "UPDATE booking_pages SET branding = ? WHERE user_id = ?", branding, c.get("user").id);
    return c.json({ ok: true });
  });

  function insertLink(userId: string, b: z.infer<typeof linkInput>): string {
    let slug = b.slug ?? slugify(b.title);
    for (
      let i = 2;
      one(db, "SELECT 1 FROM booking_links WHERE user_id = ? AND slug = ?", userId, slug);
      i++
    ) {
      slug = `${b.slug ?? slugify(b.title)}-${i}`;
    }
    const id = randomUUID();
    run(
      db,
      `INSERT INTO booking_links (id, user_id, slug, hidden, title, description, title_template, durations, level,
         hours_set_id, notice_minutes, range_end_days, buffer_before, buffer_after, max_per_day, max_per_week, location, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      slug,
      pageColumns(db, userId, b)?.hidden ?? 0,
      b.title,
      b.description ?? "",
      "{title} with {attendee}",
      JSON.stringify(b.durations),
      b.level ?? 2,
      b.hoursSetId ?? null,
      b.noticeMinutes ?? 240,
      b.rangeEndDays ?? 30,
      b.bufferBefore ?? 0,
      b.bufferAfter ?? 0,
      b.maxPerDay ?? null,
      b.maxPerWeek ?? null,
      locationText(b.locations?.[0]),
      now(),
    );
    const options = [
      ["group_id", pageColumns(db, userId, b)?.group_id ?? undefined] as [
        string,
        string | undefined,
      ],
      ["locations", b.locations && JSON.stringify(b.locations)] as [string, string | undefined],
      ...optionColumns(b, undefined, now()),
    ].filter(([, v]) => v !== undefined);
    if (options.length > 0) {
      run(
        db,
        `UPDATE booking_links SET ${options.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
        ...options.map(([, v]) => v ?? null),
        id,
      );
    }
    // A personal link: the creator is its only organizer and its host.
    run(
      db,
      `INSERT INTO booking_link_people (link_id, user_id, kind, hours_set_id, required, is_host)
       VALUES (?, ?, 'organizer', ?, 1, 1)`,
      id,
      userId,
      b.hoursSetId ?? null,
    );
    return id;
  }

  /** The link, when the user owns it or is one of its people (team rule 22). */
  const editable = (linkId: string, userId: string) => {
    const link = one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", linkId);
    if (!link) notFound("link");
    const owner = link.user_id === userId;
    // A co-organizer who left the owner's team loses access.
    if (
      !owner &&
      !(
        sameTeam(db, link.user_id, userId) &&
        one(
          db,
          "SELECT 1 FROM booking_link_people WHERE link_id = ? AND user_id = ?",
          linkId,
          userId,
        )
      )
    ) {
      notFound("link");
    }
    return { link, owner };
  };

  r.get("/links", (c) => {
    const user = c.get("user");
    const links = all<LinkRow>(
      db,
      "SELECT * FROM booking_links WHERE user_id = ? AND source_id IS NULL ORDER BY level, created_at",
      user.id,
    );
    // Team links page group: links where the user is a co-organizer or in the pool (sharing spec).
    const { team } = membership(db, user.id);
    const teamLinks = all<LinkRow>(
      db,
      `SELECT l.* FROM booking_links l JOIN booking_link_people p ON p.link_id = l.id
       JOIN team_members m ON m.user_id = l.user_id
       WHERE p.user_id = ? AND l.user_id <> ? AND m.team_id = ? AND l.source_id IS NULL
       ORDER BY l.level, l.created_at`,
      user.id,
      user.id,
      team.id,
    );
    const members = all<{ userId: string; name: string; email: string }>(
      db,
      `SELECT u.id AS userId, u.name, u.email FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? AND u.deactivated_at IS NULL ORDER BY u.email`,
      team.id,
    );
    const sets = all<{ id: string; user_id: string; name: string }>(
      db,
      `SELECT h.id, h.user_id, h.name FROM hours_sets h JOIN team_members m ON m.user_id = h.user_id
       WHERE m.team_id = ? AND h.item_specific = 0 ORDER BY h.created_at`,
      team.id,
    );
    return c.json({
      links: links.map((l) => linkView(db, l, oneOffDays)),
      groups: all<{ id: string; slug: string; title: string; branding: string }>(
        db,
        "SELECT id, slug, title, branding FROM booking_groups WHERE user_id = ? ORDER BY created_at",
        user.id,
      ),
      teamLinks: teamLinks.map((l) => linkView(db, l, oneOffDays)),
      people: members.map((m) => ({
        ...m,
        hoursSets: sets
          .filter((h) => h.user_id === m.userId)
          .map((h) => ({ id: h.id, name: h.name })),
      })),
    });
  });

  r.post("/links", async (c) => {
    const user = c.get("user");
    const count = one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM booking_links WHERE user_id = ?",
      user.id,
    );
    const full = limitRefusal(db, "max_booking_links", count?.n ?? 0);
    if (full) return c.json(full, 409);
    if (!one(db, "SELECT 1 FROM booking_pages WHERE user_id = ?", user.id))
      return c.json({ error: "no_page" }, 400);
    const body = await jsonBody(c, linkInput);
    if (
      body.slug &&
      one(db, "SELECT 1 FROM booking_links WHERE user_id = ? AND slug = ?", user.id, body.slug)
    ) {
      return c.json({ error: "slug_taken" }, 409);
    }
    const id = insertLink(user.id, body);
    return c.json({ link: one(db, "SELECT * FROM booking_links WHERE id = ?", id) }, 201);
  });

  /** Changes a link. Only the owner may change its URL, its page and delete it (team rules 10, 22). */
  const slugTaken = (): never => {
    throw new HTTPException(409, {
      res: Response.json({ error: "slug_taken" }, { status: 409 }),
    });
  };
  /** A link slug is unique for its owner; a one-off slug also among all one-off links. */
  const slugInUse = (link: LinkRow, slug: string) =>
    one(
      db,
      "SELECT 1 FROM booking_links WHERE user_id = ? AND slug = ? AND id <> ?",
      link.user_id,
      slug,
      link.id,
    ) !== undefined ||
    (link.source_id !== null &&
      one(
        db,
        "SELECT 1 FROM booking_links WHERE source_id IS NOT NULL AND slug = ? AND id <> ?",
        slug,
        link.id,
      ) !== undefined);

  /** A calendar the owner can write to, or null for the main calendar. */
  const ownCalendar = (userId: string, id: string | null): string | null =>
    id === null || writeCalendar(db, userId, id)?.id === id ? id : invalid("calendar");

  /** Saves changes to a link, or the settings of a new one-off link. */
  function applyChanges(link: LinkRow, b: Changes): void {
    // One-off links are on no page (sharing rule 11).
    const page = link.source_id ? undefined : pageColumns(db, link.user_id, b);
    if (b.slug && b.slug !== link.slug && slugInUse(link, b.slug)) slugTaken();
    const organizers =
      b.organizers ??
      linkPeople(db, link.id)
        .filter((p) => p.kind === "organizer")
        .map((p) => ({ ...p }));
    const pool =
      b.pool ??
      linkPeople(db, link.id)
        .filter((p) => p.kind === "pool")
        .map((p) => ({ ...p }));
    if (b.organizers || b.pool) checkPeople(db, link, organizers, pool);
    const columns: [string, string | number | null | undefined][] = [
      ["title", b.title],
      ["description", b.description],
      ["slug", b.slug],
      ["hidden", page?.hidden],
      ["group_id", page?.group_id],
      ["durations", b.durations && JSON.stringify(b.durations)],
      ["level", b.level],
      ["notice_minutes", b.noticeMinutes],
      ["range_end_days", b.rangeEndDays],
      ["buffer_before", b.bufferBefore],
      ["buffer_after", b.bufferAfter],
      ["max_per_day", b.maxPerDay],
      ["max_per_week", b.maxPerWeek],
      // `location` keeps the default's text for the reminder query.
      ["location", b.locations && locationText(b.locations[0])],
      ["locations", b.locations && JSON.stringify(b.locations)],
      ["range_end_date", b.rangeEndDate],
      [
        "calendar_id",
        b.calendarId === undefined ? undefined : ownCalendar(link.user_id, b.calendarId),
      ],
      [
        "use_travel_buffer",
        b.useTravelBuffer === undefined ? undefined : b.useTravelBuffer ? 1 : 0,
      ],
      [
        "use_recovery_buffer",
        b.useRecoveryBuffer === undefined ? undefined : b.useRecoveryBuffer ? 1 : 0,
      ],
      ["branding", b.branding],
      ["title_template", b.titleTemplate],
      ["invitee_name", link.source_id ? b.inviteeName : undefined],
      ["invitee_email", link.source_id ? b.inviteeEmail?.toLowerCase() : undefined],
      ...optionColumns(b, link, now()),
    ];
    const set = columns.filter(([, v]) => v !== undefined);
    tx(db, () => {
      if (set.length > 0) {
        run(
          db,
          `UPDATE booking_links SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
          ...set.map(([, v]) => v ?? null),
          link.id,
        );
      }
      if (b.organizers || b.pool) {
        const before = linkPeople(db, link.id).map((p) => p.hoursSetId);
        // New item-specific hours get a new private set: a one-off link may share the old one.
        for (const p of [...organizers, ...pool]) {
          if ("itemHours" in p && p.itemHours)
            p.hoursSetId = createItemHours(db, p.userId, link.title, p.itemHours);
        }
        run(db, "DELETE FROM booking_link_people WHERE link_id = ?", link.id);
        const add = run.bind(
          null,
          db,
          `INSERT INTO booking_link_people (link_id, user_id, kind, hours_set_id, required, is_host, preferred, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        organizers.forEach((o, i) => {
          add(
            link.id,
            o.userId,
            "organizer",
            o.hoursSetId,
            o.required ? 1 : 0,
            o.isHost ? 1 : 0,
            0,
            i,
          );
        });
        pool.forEach((p, i) => {
          add(link.id, p.userId, "pool", p.hoursSetId, 1, 0, p.preferred ? 1 : 0, i);
        });
        for (const id of before) if (id) dropItemHours(db, id);
      }
    });
  }

  r.get("/links/:id", (c) => {
    const { link } = editable(c.req.param("id"), c.get("user").id);
    return c.json({ link: linkView(db, link, oneOffDays) });
  });

  /** Changes a link. Only the owner may change its URL, its page and delete it (team rules 10, 22). */
  r.patch("/links/:id", async (c) => {
    const user = c.get("user");
    const { link, owner } = editable(c.req.param("id"), user.id);
    const b = await jsonBody(c, linkChanges);
    // The target calendar is the owner's own calendar (booking-links.md, targetCalendar).
    if (
      !owner &&
      (b.slug !== undefined ||
        b.hidden !== undefined ||
        b.page !== undefined ||
        b.calendarId !== undefined)
    )
      forbidden();
    applyChanges(link, b);
    const saved = one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", link.id);
    return c.json({ link: saved && linkView(db, saved, oneOffDays) });
  });

  /**
   * Personalize: a one-off link that copies the source link and changes some
   * settings for one meeting (sharing rules 8-16). The creator owns it.
   */
  r.post("/links/:id/oneoff", async (c) => {
    const user = c.get("user");
    const { link: source } = editable(c.req.param("id"), user.id);
    if (source.source_id) return c.json({ error: "one_off_source" }, 400);
    const b = await jsonBody(c, linkChanges);
    const id = randomUUID();
    // Proposed default: a random token of 16 lowercase letters and digits (rule 15).
    const token = () => {
      const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
      return [...randomBytes(16)].map((n) => abc[n % abc.length]).join("");
    };
    const slug = b.slug ?? token();
    tx(db, () => {
      run(
        db,
        `INSERT INTO booking_links (id, user_id, slug, hidden, title, description, title_template, durations,
           level, hours_set_id, notice_minutes, range_end_days, buffer_before, buffer_after, max_per_day,
           max_per_week, location, created_at, use_recovery_buffer, branding, questions, reminder_enabled,
           reminder_hours, reminder_message, reminder_saved_at, redirect_url, default_duration, source_id,
           range_end_date, calendar_id, use_travel_buffer, locations)
         SELECT ?, ?, ?, 1, title, description, title_template, durations, level, hours_set_id,
           notice_minutes, range_end_days, buffer_before, buffer_after, max_per_day, max_per_week, location,
           ?, use_recovery_buffer, branding, questions, reminder_enabled, reminder_hours, reminder_message,
           ?, redirect_url, default_duration, id, range_end_date, calendar_id, use_travel_buffer, locations
         FROM booking_links WHERE id = ?`,
        id,
        user.id,
        `tmp-${id}`,
        now(),
        now(),
        source.id,
      );
      run(
        db,
        `INSERT INTO booking_link_people (link_id, user_id, kind, hours_set_id, required, is_host, preferred, position)
         SELECT ?, user_id, kind, hours_set_id, required, is_host, preferred, position
         FROM booking_link_people WHERE link_id = ?`,
        id,
        source.id,
      );
      const created = one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", id);
      if (!created) throw new Error("one-off link missing");
      applyChanges(created, { ...b, slug });
    });
    const saved = one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", id);
    return c.json({ link: saved && linkView(db, saved, oneOffDays) }, 201);
  });

  r.delete("/links/:id", (c) => {
    const { link, owner } = editable(c.req.param("id"), c.get("user").id);
    if (!owner) forbidden();
    // Booked events stay (booking-links rule 20).
    const sets = linkPeople(db, link.id).map((p) => p.hoursSetId);
    run(db, "DELETE FROM booking_links WHERE id = ?", link.id);
    for (const id of sets) if (id) dropItemHours(db, id);
    return c.body(null, 204);
  });

  r.get("/bookings", (c) => {
    const id = c.get("user").id;
    return c.json({
      bookings: all(
        db,
        `SELECT b.id, b.start_ms, b.end_ms, b.name, b.email, b.status, l.title AS link_title FROM bookings b
         LEFT JOIN booking_links l ON l.id = b.link_id
         WHERE b.user_id = ? OR b.host_id = ?
           OR b.id IN (SELECT booking_id FROM booking_participants WHERE user_id = ?)
         ORDER BY b.start_ms DESC LIMIT 200`,
        id,
        id,
        id,
      ),
    });
  });

  /** Every team member's booking page and public links (teams-executive-assistant-use rule 5). */
  r.get("/directory", (c) => {
    const { team } = membership(db, c.get("user").id);
    const members = all<{ id: string; name: string; email: string; slug: string | null }>(
      db,
      `SELECT u.id, u.name, u.email, p.slug FROM team_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN booking_pages p ON p.user_id = u.id
       WHERE m.team_id = ? AND u.deactivated_at IS NULL ORDER BY u.name, u.email`,
      team.id,
    );
    return c.json({
      members: members.map((m) => ({
        name: m.name,
        email: m.email,
        page: m.slug,
        links: m.slug
          ? all<{ title: string; slug: string; durations: string }>(
              db,
              "SELECT title, slug, durations FROM booking_links WHERE user_id = ? AND hidden = 0 AND group_id IS NULL ORDER BY level, created_at",
              m.id,
            ).map((l) => ({ ...l, durations: JSON.parse(l.durations) as number[] }))
          : [],
      })),
    });
  });
  return r;
}

type OnEvent = (linkId: string, type: WebhookType, body: Record<string, unknown>) => void;

interface MeetingFacts {
  id: string;
  title: string;
  start: number;
  end: number;
  name: string;
  email: string;
  message: string;
  created: number;
  custom: CustomData;
  hostId: string;
  participants: string[];
  answers: Answer[];
  /** The chosen location's text and the booker's CC guests. */
  location: string;
  cc: string[];
  rescheduled?: number;
  cancelled?: number;
}

/** The meeting object of a webhook payload (integrations-webhooks.md rule 17). */
function meetingObject(db: Db, link: LinkRow, b: MeetingFacts, baseUrl: string) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const people = [b.hostId, ...b.participants.filter((p) => p !== b.hostId)].flatMap((id) => {
    const u = one<{ id: string; email: string; name: string; time_zone: string }>(
      db,
      "SELECT id, email, name, time_zone FROM users WHERE id = ?",
      id,
    );
    return u
      ? [
          {
            is_host: id === b.hostId,
            email: u.email,
            user_id: u.id,
            name: u.name,
            time_zone: { id: u.time_zone },
          },
        ]
      : [];
  });
  return {
    meeting_id: b.id,
    meeting_title: b.title,
    meeting_url: new URL("/links", baseUrl).toString(),
    booking_link_id: link.id,
    booking_link_title: link.title,
    booking_link_description: link.description,
    start_time: iso(b.start),
    end_time: iso(b.end),
    scheduled_at: iso(b.created),
    ...(b.rescheduled ? { rescheduled_at: iso(b.rescheduled) } : {}),
    ...(b.cancelled ? { cancelled_at: iso(b.cancelled) } : {}),
    participants: people,
    attendee: { email: b.email, name: b.name },
    ccs: b.cc,
    message: b.message,
    location: b.location ? { text: b.location } : null,
    answers: b.answers
      .filter((a) => a.answer)
      .map((a) => ({ question: a.question, answer: a.answer })),
    custom_data: b.custom,
  };
}

/** Host and guests of a booking at a slot: organizers, and the round-robin assignee (rules 16, 18). */
function placementFor(
  db: Db,
  link: LinkRow,
  slot: OfferedTime,
  keep: string | null,
  now: number,
): { hostId: string; assignee: string | null; parties: Party[]; organizerName: string } {
  const { people } = linkTeam(db, link);
  const organizers = people.filter((p) => p.kind === "organizer");
  let assignee: string | null = null;
  if (slot.pool) {
    // Rule 20: a reschedule keeps the member who still passes; otherwise rule 16 again.
    const preferred = new Set(
      people.filter((p) => p.kind === "pool" && p.preferred).map((p) => p.userId),
    );
    assignee =
      keep && slot.pool.includes(keep)
        ? keep
        : (assign(db, link.id, slot.pool, preferred, now) ?? null);
  }
  const hostId = organizers.find((o) => o.isHost)?.userId ?? assignee ?? link.user_id;
  const parties: Party[] = organizers.map((o) => ({ userId: o.userId, optional: !o.required }));
  if (assignee && !parties.some((p) => p.userId === assignee))
    parties.push({ userId: assignee, optional: false });
  return { hostId, assignee, parties, organizerName: organizerName(db, link, assignee) };
}

/** `{organizer}`: the main organizer, or the assignee on a link without organizers (edge case 5). */
function organizerName(db: Db, link: LinkRow, assignee: string | null): string {
  const hasOrganizers = linkPeople(db, link.id).some((p) => p.kind === "organizer");
  return nameOf(db, hasOrganizers ? link.user_id : (assignee ?? link.user_id));
}

const contact = (db: Db, id: string | null) =>
  id
    ? (one<{ name: string; email: string }>(db, "SELECT name, email FROM users WHERE id = ?", id) ??
      null)
    : null;

const zoneInput = z.string().max(64).refine(isValidTimeZone).optional();

/**
 * The link at a booking page URL: /book/<page slug>/<link slug>. The page is
 * the owner's main page (main and hidden links) or a link group (its links).
 */
export function resolveLink(db: Db, page: string, link: string): LinkRow | undefined {
  if (page === "o") {
    return one<LinkRow>(
      db,
      "SELECT * FROM booking_links WHERE source_id IS NOT NULL AND slug = ?",
      link,
    );
  }
  return (
    one<LinkRow>(
      db,
      `SELECT l.* FROM booking_links l JOIN booking_pages p ON p.user_id = l.user_id
       WHERE p.slug = ? AND l.slug = ? AND l.group_id IS NULL AND l.source_id IS NULL`,
      page,
      link,
    ) ??
    one<LinkRow>(
      db,
      `SELECT l.* FROM booking_links l JOIN booking_groups g ON g.id = l.group_id
       WHERE g.slug = ? AND l.slug = ?`,
      page,
      link,
    )
  );
}

/** When a one-off link stops working: its creation plus the instance's lifetime (sharing rule 14). */
/**
 * Sharing rule 14: 30 days after creation, counted in the creator's zone: the
 * same wall-clock time `days` local days later, also across a DST change.
 */
export function oneOffExpiry(
  link: Pick<LinkRow, "source_id" | "created_at">,
  days: number,
  zone: string,
): number | null {
  if (!link.source_id) return null;
  return addLocalDays(link.created_at, days, zone);
}

/** Public booking API: no session; the page and link slugs or a manage token identify the data. */
export function publicBookingRoutes(
  db: Db,
  sync: SyncService,
  baseUrl: string,
  now: () => number,
  onEvent: OnEvent,
  mailer: Mailer,
  oneOffDays: number,
): Hono {
  const r = new Hono();
  const findLink = (page: string, link: string) => resolveLink(db, page, link);
  const expiryOf = (link: LinkRow) => oneOffExpiry(link, oneOffDays, zoneOf(db, link.user_id));
  const expired = (link: LinkRow) => {
    const at = expiryOf(link);
    return at !== null && now() >= at;
  };
  // A one-off link fires its source link's webhooks (sharing rule 16).
  const event: OnEvent = (linkId, type, body) => {
    const l = one<{ source_id: string | null }>(
      db,
      "SELECT source_id FROM booking_links WHERE id = ?",
      linkId,
    );
    onEvent(l?.source_id ?? linkId, type, body);
  };

  /** A main booking page or a link group page, with the links it lists (sharing rules 1, 3). */
  r.get("/pages/:page", (c) => {
    const slug = c.req.param("page");
    const main = one<{ user_id: string; slug: string; branding: Branding }>(
      db,
      "SELECT user_id, slug, branding FROM booking_pages WHERE slug = ?",
      slug,
    );
    const group = main
      ? undefined
      : one<{ id: string; user_id: string; slug: string; title: string; branding: Branding }>(
          db,
          "SELECT id, user_id, slug, title, branding FROM booking_groups WHERE slug = ?",
          slug,
        );
    const page = main ?? group;
    if (!page) notFound("page");
    const owner = one<{ name: string }>(db, "SELECT name FROM users WHERE id = ?", page.user_id);
    const links = group
      ? all<LinkRow>(
          db,
          "SELECT * FROM booking_links WHERE group_id = ? ORDER BY level, created_at",
          group.id,
        )
      : all<LinkRow>(
          db,
          "SELECT * FROM booking_links WHERE user_id = ? AND hidden = 0 AND group_id IS NULL ORDER BY level, created_at",
          page.user_id,
        );
    return c.json({
      name: owner?.name ?? "",
      title: group?.title ?? null,
      slug: page.slug,
      links: links.map(publicLink),
      branding: brandingFor(db, page.user_id, page.branding),
    });
  });

  r.get("/pages/:page/:link", (c) => {
    const link = findLink(c.req.param("page"), c.req.param("link"));
    if (!link) notFound("link");
    return c.json({
      link: publicLink(link),
      organizers: organizerNames(db, link),
      timeZone: zoneOf(db, link.user_id),
      branding: brandingFor(db, link.user_id, resolveLinkBranding(db, link)),
      oneOff: link.source_id ? { expiresAt: expiryOf(link), expired: expired(link) } : null,
      paused: targetProblem(db, link) !== null,
    });
  });

  r.get("/pages/:page/:link/times", (c) => {
    const link = findLink(c.req.param("page"), c.req.param("link"));
    if (!link) notFound("link");
    const q = z
      .object({
        duration: z.coerce.number().int(),
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
        token: z.string().optional(),
      })
      .safeParse(c.req.query());
    const durations = JSON.parse(link.durations) as number[];
    if (
      !q.success ||
      !durations.includes(q.data.duration) ||
      q.data.to <= q.data.from ||
      q.data.to - q.data.from > MAX_SPAN
    ) {
      return c.json({ error: "invalid_query" }, 400);
    }
    const resched = q.data.token
      ? one<{ id: string }>(
          db,
          "SELECT id FROM bookings WHERE token_hash = ? AND link_id = ?",
          hash(q.data.token),
          link.id,
        )?.id
      : undefined;
    // An expired one-off link offers no times; its bookings can still move (rule 14).
    if (expired(link) && !resched) return c.json({ times: [] });
    // The pool members stay on the server: the booker sees no host before confirming.
    return c.json({
      times: linkTimes(db, link, q.data.duration, q.data.from, q.data.to, now(), resched).map(
        (t) => ({ start: t.start, end: t.end, preferred: t.preferred }),
      ),
    });
  });

  const bookInput = z.object({
    start: z.number().int(),
    duration: z.number().int(),
    name: z.string().trim().min(1).max(200),
    email: z.email(),
    message: z.string().max(4000).optional(),
    answers: z.array(z.string().max(4000)).max(10).optional(),
    /** Guests the booker adds (booking page details form). */
    cc: z.array(z.email()).max(10).optional(),
    /** The index of the chosen location option. */
    location: z.number().int().min(0).max(9).optional(),
    timeZone: zoneInput,
    params: z
      .array(z.tuple([z.string().max(200), z.string().max(2000)]))
      .max(100)
      .optional(),
  });

  const slotAt = (
    link: LinkRow,
    start: number,
    duration: number,
    resched: string | undefined,
    location: LocationOption | null,
  ) =>
    linkTimes(db, link, duration, start, start + duration * 60_000, now(), resched, location).find(
      (t) => t.start === start,
    );

  /** The event description: message, answers, then the booker's actions (rule 12). */
  function description(message: string, answers: Answer[], token: string): string {
    const url = new URL(`/book/manage/${token}`, baseUrl).toString();
    return [
      message,
      ...answers.filter((a) => a.answer).map((a) => `${a.question}\n${a.answer}`),
      `Reschedule: ${url}?action=reschedule\nCancel: ${url}?action=cancel`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const mail = (
    change: BookingChange,
    link: LinkRow,
    b: {
      start: number;
      end: number;
      name: string;
      email: string;
      zone: string;
      message: string;
      answers: Answer[];
      people: string[];
      token: string | null;
      location: string;
      cc: string[];
    },
  ) =>
    notifyBooking(db, mailer, baseUrl, change, {
      link,
      title: link.title,
      start: b.start,
      end: b.end,
      location: b.location,
      bookerName: b.name,
      bookerEmail: b.email,
      cc: b.cc,
      bookerZone: b.zone,
      message: b.message,
      answers: b.answers,
      people: b.people,
      token: b.token,
    });

  const noCalendar = (err: unknown) => err instanceof Error && err.message === "no_calendar";

  r.post("/pages/:page/:link/book", async (c) => {
    const link = findLink(c.req.param("page"), c.req.param("link"));
    if (!link) notFound("link");
    if (expired(link)) return c.json({ error: "expired" }, 410);
    if (targetProblem(db, link)) return c.json({ error: "paused" }, 409);
    const body = await jsonBody(c, bookInput);
    if (!(JSON.parse(link.durations) as number[]).includes(body.duration))
      return c.json({ error: "invalid_duration" }, 400);
    const checked = checkAnswers(link, body.answers ?? []);
    if ("error" in checked) return c.json(checked, 400);
    const { answers } = checked;
    const options = locationsOf(link);
    if (body.location !== undefined && body.location >= Math.max(1, options.length))
      return c.json({ error: "invalid_location" }, 400);
    const chosen = options[body.location ?? 0] ?? null;
    const location = locationText(chosen);
    const cc = [...new Set((body.cc ?? []).map((e) => e.toLowerCase()))].filter(
      (e) => e !== body.email.toLowerCase(),
    );
    const zone = body.timeZone ?? zoneOf(db, link.user_id);
    const result = await sync.exclusive(link.user_id, async () => {
      // Check again inside the owner's queue so two bookers cannot take one slot.
      const slot = slotAt(link, body.start, body.duration, undefined, chosen);
      if (!slot) {
        // The time is free, but not the travel time the chosen address needs (availability rule 10).
        if (needsTravel(chosen) && slotAt(link, body.start, body.duration, undefined, null))
          return { error: "no_travel_time" as const };
        return { error: "slot_taken" as const };
      }
      const plan = placementFor(db, link, slot, null, now());
      const id = randomUUID();
      const token = randomBytes(24).toString("base64url");
      const end = body.start + body.duration * 60_000;
      const custom = customData(body.params ?? []);
      const title = eventTitle(link, plan.organizerName, body.name);
      run(
        db,
        `INSERT INTO bookings (id, link_id, user_id, start_ms, end_ms, name, email, message, token_hash, status,
           created_at, updated_at, custom_data, host_id, assignee_id, assigned_at, answers, time_zone, cc, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        link.id,
        link.user_id,
        body.start,
        end,
        body.name,
        body.email,
        body.message ?? "",
        hash(token),
        now(),
        now(),
        JSON.stringify(custom),
        plan.hostId,
        plan.assignee,
        plan.assignee ? now() : null,
        JSON.stringify(answers),
        zone,
        JSON.stringify(cc),
        location,
      );
      let placed: { calendarId: string; eventId: string } | null;
      try {
        placed = await writeBookingEvents(db, sync, id, null, {
          hostId: plan.hostId,
          parties: plan.parties,
          event: {
            summary: title,
            description: description(body.message ?? "", answers, token),
            start: body.start,
            end,
            location,
            bookerEmail: body.email,
            cc,
            calendarId: plan.hostId === link.user_id ? link.calendar_id : null,
          },
        });
      } catch (err) {
        run(db, "DELETE FROM bookings WHERE id = ?", id);
        if (noCalendar(err)) return { error: "no_calendar" as const };
        throw err;
      }
      run(
        db,
        "UPDATE bookings SET calendar_id = ?, event_id = ? WHERE id = ?",
        placed?.calendarId ?? null,
        placed?.eventId ?? null,
        id,
      );
      const people = [plan.hostId, ...plan.parties.map((p) => p.userId)];
      event(link.id, "booking_link.meeting.created", {
        meeting: meetingObject(
          db,
          link,
          {
            id,
            title,
            start: body.start,
            end,
            name: body.name,
            email: body.email,
            message: body.message ?? "",
            created: now(),
            custom,
            hostId: plan.hostId,
            participants: plan.parties.map((p) => p.userId),
            answers,
            location,
            cc,
          },
          baseUrl,
        ),
      });
      mail("created", link, {
        start: body.start,
        end,
        name: body.name,
        email: body.email,
        zone,
        message: body.message ?? "",
        answers,
        people,
        token,
        location,
        cc,
      });
      return {
        token,
        start: body.start,
        end,
        organizers: organizerNames(db, link),
        location,
        // Round robin: the confirmation names the assigned member (team rule 23).
        assignee: contact(db, plan.assignee),
      };
    });
    if ("error" in result)
      return c.json(
        result,
        result.error === "slot_taken" || result.error === "no_travel_time" ? 409 : 500,
      );
    return c.json(result, 201);
  });

  const byToken = (token: string) =>
    one<BookingRow>(db, "SELECT * FROM bookings WHERE token_hash = ?", hash(token));

  const participants = (b: BookingRow) =>
    all<{ user_id: string }>(
      db,
      "SELECT user_id FROM booking_participants WHERE booking_id = ?",
      b.id,
    ).map((p) => p.user_id);

  const facts = (
    b: BookingRow,
    link: LinkRow | undefined,
    title: string,
  ): Omit<MeetingFacts, "start" | "end"> => ({
    id: b.id,
    title,
    name: b.name,
    email: b.email,
    message: b.message,
    created: b.created_at,
    custom: JSON.parse(b.custom_data) as CustomData,
    hostId: b.host_id ?? b.user_id,
    participants: participants(b),
    answers: JSON.parse(b.answers) as Answer[],
    location: link ? locationText(bookedLocation(link, b.location)) : (b.location ?? ""),
    cc: JSON.parse(b.cc) as string[],
  });

  r.get("/bookings/:token", (c) => {
    const b = byToken(c.req.param("token"));
    if (!b) notFound("booking");
    const link = b.link_id
      ? one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", b.link_id)
      : undefined;
    return c.json({
      booking: {
        start: b.start_ms,
        end: b.end_ms,
        name: b.name,
        status: b.status,
        timeZone: b.time_zone,
      },
      link: link ? publicLink(link) : null,
      page: link ? linkPageSlug(db, link) : null,
      assignee: contact(db, b.assignee_id),
    });
  });

  r.post("/bookings/:token/reschedule", async (c) => {
    const token = c.req.param("token");
    const b = byToken(token);
    if (!b || b.status !== "booked" || !b.link_id) notFound("booking");
    const link = one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", b.link_id);
    if (!link) notFound("link");
    const { start, timeZone } = await jsonBody(
      c,
      z.object({ start: z.number().int(), timeZone: zoneInput }),
    );
    const zone = timeZone ?? b.time_zone;
    const duration = (b.end_ms - b.start_ms) / 60_000;
    const end = start + duration * 60_000;
    const where = bookedLocation(link, b.location);
    const result = await sync.exclusive(b.user_id, async () => {
      const slot = slotAt(link, start, duration, b.id, where);
      if (!slot) return { error: "slot_taken" as const };
      const plan = placementFor(db, link, slot, b.assignee_id, now());
      const title = eventTitle(link, plan.organizerName, b.name);
      const before = facts(b, link, title);
      let placed: { calendarId: string; eventId: string } | null;
      try {
        placed = await writeBookingEvents(
          db,
          sync,
          b.id,
          { hostId: b.host_id ?? b.user_id, calendarId: b.calendar_id, eventId: b.event_id },
          {
            hostId: plan.hostId,
            parties: plan.parties,
            event: {
              summary: title,
              description: description(b.message, before.answers, token),
              start,
              end,
              location: locationText(where),
              bookerEmail: b.email,
              cc: JSON.parse(b.cc) as string[],
              calendarId: plan.hostId === link.user_id ? link.calendar_id : null,
            },
          },
        );
      } catch (err) {
        if (noCalendar(err)) return { error: "no_event" as const };
        if (err instanceof Error && err.message === "account_disconnected")
          return { error: "account_disconnected" as const };
        throw err;
      }
      // A moved booking gets its reminder again for the new time (rule 21).
      run(
        db,
        `UPDATE bookings SET start_ms = ?, end_ms = ?, updated_at = ?, calendar_id = ?, event_id = ?,
           host_id = ?, assignee_id = ?, assigned_at = CASE WHEN assignee_id IS ? THEN assigned_at ELSE ? END,
           time_zone = ?, reminder_sent_at = NULL
         WHERE id = ?`,
        start,
        end,
        now(),
        placed?.calendarId ?? null,
        placed?.eventId ?? null,
        plan.hostId,
        plan.assignee,
        plan.assignee,
        now(),
        zone,
        b.id,
      );
      const after = facts({ ...b, host_id: plan.hostId }, link, title);
      event(link.id, "booking_link.meeting.updated", {
        previous_meeting: meetingObject(
          db,
          link,
          { ...before, start: b.start_ms, end: b.end_ms },
          baseUrl,
        ),
        new_meeting: meetingObject(db, link, { ...after, start, end, rescheduled: now() }, baseUrl),
        change_reason: "rescheduled",
      });
      mail("rescheduled", link, {
        start,
        end,
        name: b.name,
        email: b.email,
        zone,
        message: b.message,
        answers: before.answers,
        people: [plan.hostId, ...plan.parties.map((p) => p.userId)],
        token,
        location: locationText(where),
        cc: before.cc,
      });
      return { start, end, assignee: contact(db, plan.assignee) };
    });
    if ("error" in result)
      return c.json(
        result,
        result.error === "slot_taken" || result.error === "account_disconnected" ? 409 : 500,
      );
    return c.json(result);
  });

  r.post("/bookings/:token/cancel", async (c) => {
    const b = byToken(c.req.param("token"));
    if (!b || b.status !== "booked") notFound("booking");
    await sync.exclusive(b.user_id, async () => {
      const link = b.link_id
        ? one<LinkRow>(db, "SELECT * FROM booking_links WHERE id = ?", b.link_id)
        : undefined;
      const title = link
        ? eventTitle(link, organizerName(db, link, b.assignee_id), b.name)
        : b.name;
      const before = facts(b, link, title);
      await writeBookingEvents(
        db,
        sync,
        b.id,
        { hostId: b.host_id ?? b.user_id, calendarId: b.calendar_id, eventId: b.event_id },
        null,
      );
      run(db, "UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), b.id);
      if (link) {
        event(link.id, "booking_link.meeting.cancelled", {
          meeting: meetingObject(
            db,
            link,
            { ...before, start: b.start_ms, end: b.end_ms, cancelled: now() },
            baseUrl,
          ),
        });
        mail("cancelled", link, {
          start: b.start_ms,
          end: b.end_ms,
          name: b.name,
          email: b.email,
          zone: b.time_zone,
          message: b.message,
          answers: before.answers,
          people: [before.hostId, ...before.participants],
          token: null,
          location: before.location,
          cc: before.cc,
        });
      }
    });
    return c.json({ ok: true });
  });

  return r;
}
