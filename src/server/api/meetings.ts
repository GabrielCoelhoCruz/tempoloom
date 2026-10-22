// Flexible meetings (docs/specs/meetings-flexible.md, meetings-flexible-rescheduling.md).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import { plan } from "../../scheduler/plan.ts";
import {
  defaultEventSettings,
  readEventSettings,
  waitingNote,
} from "../../shared/event-settings.ts";
import { addDays, type LocalDate, weekdayOf } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { editedEventSettings, eventSettingsInput, newEventSettings } from "../event-settings.ts";
import { jsonBody, notFound } from "../http.ts";
import { createItemHours, dropItemHours, itemHoursSchema, saveItemHours } from "../item-hours.ts";
import type { Mailer } from "../mail.ts";
import { isPublicMailDomain } from "../mail-domains.ts";
import { availabilityMap } from "../meeting-availability.ts";
import { notifyMeetingCancelled } from "../meeting-mail.ts";
import { adoptableSeries, type Series } from "../meeting-series.ts";
import { withState } from "../planner/markers.ts";
import { logChange, meetingBoost, skippedPeriods } from "../planner/meeting-log.ts";
import { rescheduleSlot } from "../planner/meeting-reschedule.ts";
import {
  type Attendee,
  attendeesOf,
  instanceUser,
  type MeetingRow,
  meetingItem,
  meetingPeers,
} from "../planner/meetings.ts";
import { KEY_PROP, MANAGED_PROP, type ManagedRow } from "../planner/push.ts";
import { meetingGuests, planningSnapshot } from "../planner/replan.ts";
import { endOwnSeries, lockedIds, seriesTarget } from "../planner/series.ts";
import { waitingCalendars } from "../planner/write.ts";
import type { ProviderPool } from "../providers/index.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";
import { domainOf, membership } from "../teams.ts";
import { homeZone } from "../travel.ts";
import { endRank, insertRank } from "./automations.ts";
import { badRequest, hhmm, hoursSetId } from "./items.ts";

const fiveMinutes = z.number().int().min(5).max(480).multipleOf(5);
const meetingInput = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(8000).default(""),
  location: z.string().max(500).default(""),
  attendees: z
    .array(
      z.object({
        email: z.email(),
        required: z.boolean().default(true),
        /** Rule 7: the organizer's hours for this guest, in the guest's time zone. */
        hoursOverride: itemHoursSchema.nullable().default(null),
      }),
    )
    .min(1)
    .max(50),
  // Every N days, weeks or months, N 1 to 52 (meetings-flexible.md `frequency`).
  frequency: z.union([
    z.object({ period: z.literal("daily"), everyDays: z.number().int().min(1).max(52).optional() }),
    z.object({
      period: z.literal("weekly"),
      everyWeeks: z.number().int().min(1).max(52),
      idealDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    }),
    z.union([
      z.object({
        period: z.literal("monthly"),
        everyMonths: z.number().int().min(1).max(52).optional(),
        dayOfMonth: z.number().int().min(1).max(31),
      }),
      z.object({
        period: z.literal("monthly"),
        everyMonths: z.number().int().min(1).max(52).optional(),
        nth: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
          z.literal("last"),
        ]),
        weekday: z.number().int().min(1).max(7),
      }),
    ]),
  ]),
  idealTime: hhmm,
  durationMinutes: fiveMinutes,
  shortestMinutes: fiveMinutes.optional(),
  /** Rule 11: `itemSpecific` uses `itemHours` only. */
  hoursMode: z.enum(["everyone", "organizer", "itemSpecific"]).default("everyone"),
  hoursSetId: z.string().optional(),
  itemHours: itemHoursSchema.optional(),
  starting: z.iso.date().nullable().default(null),
  level: z.number().int().min(1).max(4).default(2),
  defense: z.enum(["adaptive", "busy", "free"]).default("adaptive"),
  whenUnplaceable: z.enum(["remove", "keep_as_conflict"]).default("keep_as_conflict"),
  leadHours: z.number().int().min(0).max(168).default(12),
  autoReschedule: z.enum(["none", "conservative", "moderate", "aggressive"]).default("moderate"),
  /** Visibility, reminders and the calendar of the occurrences (`visibility`, `reminders`, `targetCalendar`). */
  eventSettings: eventSettingsInput.optional(),
  /** Attach the rules to this recurring series (meetings-flexible.md rule 1). */
  series: z.object({ calendarId: z.string(), seriesId: z.string() }).optional(),
  /**
   * Guests from outside only (automations-library.md entry 32): no guest on the
   * user's own mail domain and no user of this instance. Checked on create.
   */
  externalOnly: z.boolean().optional(),
});
type MeetingInput = z.infer<typeof meetingInput>;

/**
 * Refuses a guest on the user's own domain or a person of the user's team
 * (library entry 32). Own domains come from the user's mail addresses: the
 * main email and the added calendar accounts, not ICS feeds (their name is a
 * feed title), and not public mail services. Only the user's team is checked,
 * so the refusal tells nothing about users of other teams.
 */
function checkExternal(db: Db, userId: string, attendees: { email: string }[]) {
  const own = new Set(
    all<{ email: string }>(
      db,
      `SELECT email FROM users WHERE id = ?
       UNION SELECT email FROM accounts WHERE user_id = ? AND provider <> 'ics'`,
      userId,
      userId,
    )
      .map((r) => domainOf(r.email))
      .filter((d) => d !== "" && !isPublicMailDomain(d)),
  );
  const why = "Recurring client meetings take external guests only.";
  for (const { email } of attendees) {
    const d = domainOf(email);
    // A subdomain counts too: eu.acme.com for a user at acme.com.
    if ([...own].some((o) => d === o || d.endsWith(`.${o}`)))
      badRequest("attendees", `${email.toLowerCase()} is on your own domain. ${why}`);
    if (
      one(
        db,
        `SELECT 1 FROM users u JOIN team_members m ON m.user_id = u.id
         WHERE u.email = ? COLLATE NOCASE AND m.team_id = ?`,
        email,
        membership(db, userId).team.id,
      )
    )
      badRequest("attendees", `${email.toLowerCase()} is in your team. ${why}`);
  }
}

function rowFrom(
  db: Db,
  userId: string,
  id: string,
  b: MeetingInput,
  t: number,
  rank: number,
): { row: MeetingRow; attendees: Attendee[] } {
  const email = one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email;
  const attendees = b.attendees
    .map((a) => ({
      email: a.email.toLowerCase(),
      required: a.required,
      hoursOverride: a.required ? (a.hoursOverride as WeeklyHours | null) : null,
    }))
    .filter((a, i, list) => a.email !== email && list.findIndex((x) => x.email === a.email) === i);
  if (attendees.length === 0) badRequest("attendees", "Invite at least one other person");
  const shortest = b.shortestMinutes ?? b.durationMinutes;
  if (b.hoursMode === "itemSpecific" && !b.itemHours)
    badRequest("itemHours", "Choose the days and times of the item-specific hours");
  if (shortest > b.durationMinutes)
    badRequest("shortestMinutes", "The shortest length must not be above the duration");
  const [h, m] = b.idealTime.split(":").map(Number) as [number, number];
  return {
    attendees,
    row: {
      id,
      user_id: userId,
      title: b.title,
      description: b.description,
      location: b.location,
      enabled: 1,
      level: b.level as MeetingRow["level"],
      rank,
      frequency: JSON.stringify(b.frequency),
      ideal_minute: h * 60 + m,
      duration_minutes: b.durationMinutes,
      shortest_minutes: shortest,
      // Item-specific hours are a private hours set of the meeting, used alone.
      hours_mode: b.hoursMode === "everyone" ? "everyone" : "organizer",
      hours_set_id: hoursSetId(db, userId, b.hoursSetId, "meeting"),
      starting: b.starting,
      defense: b.defense,
      when_unplaceable: b.whenUnplaceable,
      lead_minutes: b.leadHours * 60,
      created_at: t,
      rules_changed_at: t,
      auto_reschedule: b.autoReschedule,
      series_calendar_id: b.series?.calendarId ?? null,
      series_event_id: b.series?.seriesId ?? null,
      // A meeting from the form gets its own series at the next plan run (rule 2).
      series_owned: b.series ? 0 : 1,
      series_rule: "",
      // Set by POST (with the calendar check) and PUT (calendar kept).
      event_settings: "{}",
      attendee_hours: "",
    },
  };
}

function save(db: Db, row: MeetingRow, attendees: Attendee[], insert: boolean): void {
  const cols = [
    "title",
    "description",
    "location",
    "level",
    "rank",
    "frequency",
    "ideal_minute",
    "duration_minutes",
    "shortest_minutes",
    "hours_mode",
    "hours_set_id",
    "starting",
    "defense",
    "when_unplaceable",
    "lead_minutes",
    "rules_changed_at",
    "auto_reschedule",
    "event_settings",
  ] as const;
  const values = cols.map((k) => row[k]);
  if (insert) {
    // The series columns are set here and by the plan run only: an edit never
    // writes back a series id or baseline it read before (rule 2).
    const series = [
      "series_calendar_id",
      "series_event_id",
      "series_owned",
      "series_rule",
    ] as const;
    run(
      db,
      `INSERT INTO meetings (id, user_id, created_at, ${[...cols, ...series].join(", ")})
       VALUES (?, ?, ?, ${[...cols, ...series].map(() => "?").join(", ")})`,
      row.id,
      row.user_id,
      row.created_at,
      ...values,
      ...series.map((k) => row[k]),
    );
  } else {
    run(
      db,
      `UPDATE meetings SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...values,
      row.id,
    );
  }
  run(db, "DELETE FROM meeting_attendees WHERE meeting_id = ?", row.id);
  for (const a of attendees) {
    run(
      db,
      "INSERT INTO meeting_attendees (meeting_id, email, required, hours_override) VALUES (?, ?, ?, ?)",
      row.id,
      a.email,
      a.required ? 1 : 0,
      a.hoursOverride ? JSON.stringify(a.hoursOverride) : null,
    );
  }
}

/** The ranges of a meeting's item-specific hours, as stored, or null. */
const itemWeekly = (db: Db, setId: string) =>
  one<{ weekly: string }>(
    db,
    "SELECT weekly FROM hours_sets WHERE id = ? AND item_specific = 1",
    setId,
  )?.weekly ?? null;

/** What places a meeting; an edit of anything else (title, notes, guests' view) keeps its times. */
function placementKey(row: MeetingRow, attendees: Attendee[], itemHours: string | null): string {
  return JSON.stringify([
    row.frequency,
    row.ideal_minute,
    row.duration_minutes,
    row.shortest_minutes,
    row.hours_mode,
    itemHours ?? row.hours_set_id,
    row.starting,
    row.level,
    row.when_unplaceable,
    row.lead_minutes,
    [...attendees]
      .sort((a, b) => (a.email < b.email ? -1 : 1))
      .map((a) => [a.email, a.required, a.hoursOverride ?? null]),
  ]);
}

/**
 * MEET-02 rule 4: a rule change places the future occurrences again, so only an
 * edit of what places the meeting marks it changed; other edits keep the times.
 */
function rulesChangedAt(
  db: Db,
  old: MeetingRow,
  row: MeetingRow,
  attendees: Attendee[],
  b: MeetingInput,
  t: number,
): number {
  const before = placementKey(old, attendeesOf(db, old.id), itemWeekly(db, old.hours_set_id));
  const after = placementKey(
    row,
    attendees,
    b.hoursMode === "itemSpecific" ? JSON.stringify(b.itemHours) : null,
  );
  return before === after ? old.rules_changed_at : t;
}

/** The guests, organizer and location of an occurrence on a calendar of `accountId` (rules 35, 41). */
function guestsOf(db: Db, m: MeetingRow, accountId: string, userEmail: string) {
  const organizer =
    one<{ email: string }>(db, "SELECT email FROM accounts WHERE id = ?", accountId)?.email ??
    userEmail;
  return meetingGuests(
    { location: m.location, people: attendeesOf(db, m.id) },
    organizer.toLowerCase(),
    userEmail,
  );
}

function weekStartOf(db: Db, userId: string, date: LocalDate): LocalDate {
  const weekStart = getSettings(db, userId).weekStart;
  return addDays(date, -((weekdayOf(date) - weekStart + 7) % 7));
}

type Frequency = MeetingInput["frequency"];
const sameFrequency = (a: Frequency, b: Frequency) => {
  const count = (x: Frequency) =>
    x.period === "weekly" ? x.everyWeeks : x.period === "daily" ? (x.everyDays ?? 1) : null;
  return a.period === b.period && count(a) === count(b);
};

/**
 * An adopted series repeats as its recurrence rule says, every day or every N
 * weeks (rule 1), and its periods count from its first instance (rule 10).
 * Another frequency or start date would give its instances other period keys:
 * some would stay unmanaged, and the push would delete others.
 */
function seriesRules(db: Db, userId: string, f: Frequency, series: Series): LocalDate {
  const own: Frequency =
    series.everyWeeks === "daily"
      ? { period: "daily" }
      : { period: "weekly", everyWeeks: series.everyWeeks, idealDays: [series.idealDay] };
  if (!sameFrequency(own, f))
    badRequest("frequency", "A recurring meeting keeps the frequency of its calendar series");
  return f.period === "weekly" ? weekStartOf(db, userId, series.firstDate) : series.firstDate;
}

/**
 * The frequency of an adopted series comes from the series on the calendar: an
 * edit keeps its period and count, and its start date (rules 1, 10). Ideal days
 * stay editable: they do not change the periods.
 */
function keepSeriesFrequency(old: MeetingRow, f: Frequency): LocalDate | null {
  if (!sameFrequency(JSON.parse(old.frequency) as Frequency, f))
    badRequest("frequency", "A recurring meeting keeps the frequency of its calendar series");
  return old.starting;
}

/** An adopted series: the user's own recurring meeting with rules attached (rule 1). */
export const adopted = (m: MeetingRow) => m.series_event_id !== null && !m.series_owned;

/** The series carries the meeting id (rule 1, output `tlMeetingId`) and counts as managed. */
async function markSeries(db: Db, pool: ProviderPool, m: MeetingRow, userId: string) {
  const cal = seriesTarget(db, m);
  const provider = cal && pool.get(cal.account_id);
  if (!cal || !provider?.setSeriesProps || !m.series_event_id)
    badRequest("series", "This calendar cannot attach rules to a series");
  await provider.setSeriesProps(cal.provider_id, m.series_event_id, {
    [MANAGED_PROP]: "1",
    tl_user: userId,
    tl_meeting: m.id,
  });
}

/** Stops managing an adopted series: it stays on the calendar as a normal recurring event. */
async function releaseSeries(db: Db, pool: ProviderPool, m: MeetingRow) {
  run(db, "DELETE FROM managed_events WHERE kind = 'meeting' AND source_id = ?", m.id);
  const cal = seriesTarget(db, m);
  const provider = cal && pool.get(cal.account_id);
  if (cal && provider?.setSeriesProps && m.series_event_id)
    await provider.setSeriesProps(cal.provider_id, m.series_event_id, {});
}

/** What Tempoloom can see of a person (rules 4-5). */
function person(db: Db, email: string) {
  const user = instanceUser(db, email);
  return user
    ? { email, class: "user" as const, name: user.name, timeZone: user.time_zone }
    : { email, class: "none" as const, name: null, timeZone: null };
}

export function meetingRoutes(
  db: Db,
  sync: SyncService,
  now: () => number,
  mailer?: Mailer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const changed = (userId: string) => {
    sync.request(userId);
    for (const id of meetingPeers(db, userId).attendees) sync.request(id);
  };
  const own = (id: string, userId: string) => {
    const row = one<MeetingRow>(
      db,
      "SELECT * FROM meetings WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!row) notFound("meeting");
    return row;
  };

  r.get("/meetings", (c) => {
    const user = c.get("user");
    const report = JSON.parse(
      one<{ report: string }>(db, "SELECT report FROM plan_reports WHERE user_id = ?", user.id)
        ?.report ?? "[]",
    ) as { itemKind: string; itemId: string; demandKey: string; status: string; reason: string }[];
    // Accounts rule 16: the meeting's calendar is on a disconnected account.
    const waiting = waitingCalendars(db, user.id);
    const meetings = all<MeetingRow>(
      db,
      "SELECT * FROM meetings WHERE user_id = ? ORDER BY level, rank, created_at",
      user.id,
    ).map((m) => ({
      ...m,
      frequency: JSON.parse(m.frequency) as unknown,
      item_hours: itemWeekly(db, m.hours_set_id),
      ...((es) => ({ event_settings: es, disconnected: waiting(es.calendarId) }))(
        readEventSettings(m.event_settings, defaultEventSettings("meeting")),
      ),
      attendees: attendeesOf(db, m.id).map((a) => ({ ...a, ...person(db, a.email) })),
      // Rules 6-7 of MEET-01, rules 16 and 34 of MEET-02.
      availability: availabilityMap(db, user.id, m.hours_set_id, attendeesOf(db, m.id), now()),
      skipped: skippedPeriods(db, m.id),
      boost: m.enabled ? (meetingBoost(db, user.id, m, now()) ?? null) : null,
      occurrences: all<{
        id: string;
        key: string;
        start_ms: number;
        end_ms: number;
        locked: number;
      }>(
        db,
        `SELECT id, key, start_ms, end_ms, locked FROM managed_events
         WHERE user_id = ? AND kind = 'meeting' AND source_id = ? AND end_ms > ? ORDER BY start_ms`,
        user.id,
        m.id,
        now(),
      ),
      // The period of each problem: its first day, and whether it is a day or a week.
      problems: report
        .filter((e) => e.itemKind === "meeting" && e.itemId === m.id)
        .map((e) => ({
          ...e,
          period: {
            start: e.demandKey.slice(e.demandKey.lastIndexOf(":") + 1),
            kind:
              (JSON.parse(m.frequency) as { period: string }).period === "daily" ? "day" : "week",
          },
        })),
      // MEET-02 rule 31: the change log of each occurrence, newest first.
      changes: all<{
        id: number;
        occurrence_key: string;
        at: number;
        old_start: number | null;
        old_end: number | null;
        new_start: number | null;
        new_end: number | null;
        actor: string;
        reason: string;
        detail: string;
      }>(
        db,
        `SELECT id, occurrence_key, at, old_start, old_end, new_start, new_end, actor, reason, detail
         FROM meeting_changes WHERE meeting_id = ? ORDER BY id DESC LIMIT 50`,
        m.id,
      ),
    }));
    return c.json({ meetings, mailConfigured: mailer?.configured ?? false });
  });

  /** Rule 1: the user's recurring series that rules can attach to. */
  r.get("/meetings/series", (c) =>
    c.json({ series: adoptableSeries(db, c.get("user").id, now()) }),
  );

  /** Rules 6-7: the availability map of the guests in the form, before save. */
  r.post("/meetings/availability", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({ attendees: meetingInput.shape.attendees, hoursSetId: z.string().optional() }),
    );
    const attendees = body.attendees.map((a) => ({
      email: a.email.toLowerCase(),
      required: a.required,
      hoursOverride: a.hoursOverride as WeeklyHours | null,
    }));
    const set = hoursSetId(db, user.id, body.hoursSetId, "meeting");
    return c.json(availabilityMap(db, user.id, set, attendees, now()));
  });

  r.get("/meetings/person", (c) => {
    const email = z.email().safeParse(c.req.query("email"));
    if (!email.success) return c.json({ error: "invalid_email" }, 400);
    return c.json(person(db, email.data.toLowerCase()));
  });

  /** Rule 8: the next occurrences before the rules are saved. */
  r.post("/meetings/preview", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, meetingInput);
    const t = now();
    // While editing (?id=): the meeting with the new rules replaces the saved one.
    const editId = c.req.query("id");
    const old = editId ? own(editId, user.id) : null;
    const id = old?.id ?? "preview";
    const { row, attendees } = rowFrom(db, user.id, id, body, t, old?.rank ?? 0);
    if (old) {
      row.created_at = old.created_at;
      row.rules_changed_at = rulesChangedAt(db, old, row, attendees, body, t);
      row.series_event_id = old.series_event_id;
      row.series_calendar_id = old.series_calendar_id;
      row.series_owned = old.series_owned;
      if (adopted(old)) row.starting = keepSeriesFrequency(old, body.frequency);
    }
    const zone =
      one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", user.id)
        ?.time_zone ?? "UTC";
    const last =
      one<{ planned_at: number }>(
        db,
        "SELECT planned_at FROM plan_reports WHERE user_id = ?",
        user.id,
      )?.planned_at ?? 0;
    // Accounts rule 16: a meeting on a disconnected account waits, also a new
    // one on the main calendar, so the preview shows no times and says why.
    const waiting = waitingCalendars(
      db,
      user.id,
    )(
      old
        ? readEventSettings(old.event_settings, defaultEventSettings("meeting")).calendarId
        : (body.eventSettings?.calendarId ?? null),
    );
    const { snapshot } = planningSnapshot(db, user.id, zone, getSettings(db, user.id), t, last);
    if (body.hoursMode === "itemSpecific" && body.itemHours) {
      row.hours_set_id = "preview-hours";
      snapshot.hours = { ...snapshot.hours, [row.hours_set_id]: body.itemHours };
    }
    const item = meetingItem(db, user.id, row, attendees, t, snapshot.windowEnd, last, new Map());
    const result = plan({
      ...snapshot,
      meetings: [...snapshot.meetings.filter((m) => m.id !== id), ...(waiting ? [] : [item])],
    });
    const before = new Map(snapshot.current.map((p) => [p.key, p]));
    const moved = result.placements.filter((p) => {
      const b = before.get(p.key);
      return p.itemId !== id && b && (b.start !== p.start || b.end !== p.end);
    }).length;
    return c.json({
      occurrences: result.placements
        .filter((p) => p.kind === "meeting" && p.itemId === id)
        .sort((a, b) => a.start - b.start)
        .slice(0, 4)
        .map((p) => ({ start: p.start, end: p.end, conflict: p.conflict })),
      problems: result.report
        .filter((e) => e.itemKind === "meeting" && e.itemId === id)
        .slice(0, 4),
      moved,
      waiting,
    });
  });

  r.post("/meetings", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, meetingInput);
    if (body.externalOnly) checkExternal(db, user.id, body.attendees);
    const id = randomUUID();
    const series = body.series
      ? adoptableSeries(db, user.id, now()).find(
          (x) => x.calendarId === body.series?.calendarId && x.seriesId === body.series.seriesId,
        )
      : undefined;
    if (body.series && !series) badRequest("series", "Pick a recurring meeting you organize");
    const { row, attendees } = rowFrom(db, user.id, id, body, now(), 0);
    row.event_settings = JSON.stringify(
      newEventSettings(db, user.id, "meeting", body.eventSettings),
    );
    // Called in a transaction, after any wait for the series: the rank shift
    // and the insert are one change (SCH-71).
    const create = () => {
      if (body.hoursMode === "itemSpecific" && body.itemHours)
        row.hours_set_id = createItemHours(db, user.id, row.title, body.itemHours);
      row.rank = insertRank(db, "flexible_meeting", user.id, row.level);
      save(db, row, attendees, true);
    };
    if (series) {
      // An adopted series keeps its id; its instances are placed from the next sync on.
      row.starting = seriesRules(db, user.id, body.frequency, series);
      await sync.exclusive(user.id, async (pool) => {
        await markSeries(db, pool, row, user.id);
        tx(db, create);
      });
    } else {
      tx(db, create);
    }
    changed(user.id);
    return c.json({ id }, 201);
  });

  r.put("/meetings/:id", async (c) => {
    const user = c.get("user");
    own(c.req.param("id"), user.id);
    const body = await jsonBody(c, meetingInput);
    // Read in the queue: a plan run may write the series meanwhile (rule 2).
    // The edit is saved here; the plan run writes it to the series master.
    await sync.exclusive(user.id, async () => {
      const old = own(c.req.param("id"), user.id);
      const t = now();
      const { row, attendees } = rowFrom(db, user.id, old.id, body, t, old.rank);
      if (adopted(old)) row.starting = keepSeriesFrequency(old, body.frequency);
      const rulesChanged = rulesChangedAt(db, old, row, attendees, body, t);
      tx(db, () => {
        if (body.hoursMode === "itemSpecific" && body.itemHours)
          row.hours_set_id = saveItemHours(
            db,
            user.id,
            old.hours_set_id,
            row.title,
            body.itemHours,
          );
        // Rule 7: a new priority puts the meeting at the end of its new group.
        if (row.level !== old.level) row.rank = endRank(db, user.id, row.level);
        save(
          db,
          {
            ...row,
            rules_changed_at: rulesChanged,
            created_at: old.created_at,
            // The calendar is set at creation only (`targetCalendar`).
            event_settings: JSON.stringify(
              editedEventSettings(
                readEventSettings(old.event_settings, defaultEventSettings("meeting")),
                body.eventSettings,
              ),
            ),
          },
          attendees,
          false,
        );
        if (row.hours_set_id !== old.hours_set_id) dropItemHours(db, old.hours_set_id);
      });
    });
    changed(user.id);
    return c.json({ ok: true });
  });

  /**
   * Rule 27 of MEET-02: off removes future occurrences and keeps the rules.
   * An adopted series stays as it is; Tempoloom only stops managing it (open question 1).
   */
  r.post("/meetings/:id/enabled", async (c) => {
    const user = c.get("user");
    own(c.req.param("id"), user.id);
    const { enabled } = await jsonBody(c, z.object({ enabled: z.boolean() }));
    await sync.exclusive(user.id, async (pool) => {
      // Read in the queue, so a series that a plan run just wrote is ended too.
      const m = own(c.req.param("id"), user.id);
      run(
        db,
        "UPDATE meetings SET enabled = ?, rules_changed_at = ? WHERE id = ?",
        enabled ? 1 : 0,
        now(),
        m.id,
      );
      if (adopted(m)) {
        if (enabled) await markSeries(db, pool, m, user.id);
        else await releaseSeries(db, pool, m);
      } else if (!enabled)
        await endOwnSeries(db, (id) => pool.get(id), m, now(), lockedIds(db, m, now()));
    });
    changed(user.id);
    return c.json({ ok: true });
  });

  /** MEET-02 rules 11 and 17: apply a suggested time; it is a manual move and locks. */
  r.post("/meetings/:id/move", async (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const { eventId, start } = await jsonBody(
      c,
      z.object({ eventId: z.string(), start: z.number().int() }),
    );
    const markers = getSettings(db, user.id).markers;
    const result = await sync.exclusive(user.id, async (pool) => {
      const row = one<ManagedRow & { account_id: string; provider_id: string }>(
        db,
        `SELECT m.*, c.account_id, c.provider_id FROM managed_events m JOIN calendars c ON c.id = m.calendar_id
         WHERE m.id = ? AND m.user_id = ? AND m.kind = 'meeting' AND m.source_id = ?`,
        eventId,
        user.id,
        m.id,
      );
      if (!row?.event_id) return "missing" as const;
      if (row.start_ms <= now() || start <= now()) return "started" as const;
      const end = start + (row.end_ms - row.start_ms);
      const title = row.user_edited ? row.title : withState(markers, m.title, "locked");
      // Only the time, title and status: the organizer's calendar edits stay (rule 22).
      const ev = await pool
        .get(row.account_id)
        .editExternal(
          row.provider_id,
          row.event_id,
          { summary: title, start, end, busy: true },
          row.etag,
        );
      cacheEvent(db, row.calendar_id, ev);
      run(
        db,
        "UPDATE managed_events SET start_ms = ?, end_ms = ?, title = ?, busy = 1, locked = 1, etag = ? WHERE id = ?",
        start,
        end,
        title,
        ev.etag,
        row.id,
      );
      logChange(
        db,
        user.id,
        {
          meetingId: m.id,
          key: row.key,
          oldStart: row.start_ms,
          oldEnd: row.end_ms,
          newStart: start,
          newEnd: end,
          actor: "organizer",
          reason: "manualMove",
          written: true,
        },
        now(),
      );
      return "ok" as const;
    });
    if (result === "missing") notFound("occurrence");
    if (result === "started") return c.json({ error: "started" }, 409);
    changed(user.id);
    return c.json({ ok: true });
  });

  /**
   * An occurrence and who acts on it: its organizer, or the one guest of a 1:1
   * who is a user here (MEET-02 rule 26). Others get 404.
   */
  const occurrence = (eventId: string, user: { id: string; email: string }) => {
    const row = one<ManagedRow & { account_id: string; provider_id: string }>(
      db,
      `SELECT m.*, c.account_id, c.provider_id FROM managed_events m JOIN calendars c ON c.id = m.calendar_id
       WHERE m.id = ? AND m.kind = 'meeting'`,
      eventId,
    );
    const m =
      row &&
      one<MeetingRow>(
        db,
        "SELECT * FROM meetings WHERE id = ? AND user_id = ?",
        row.source_id,
        row.user_id,
      );
    if (!row?.event_id || !m) notFound("occurrence");
    if (m.user_id === user.id) return { row, m, guest: null };
    const [only, ...more] = attendeesOf(db, m.id);
    if (more.length > 0 || !only?.required || only.email !== user.email.toLowerCase())
      notFound("occurrence");
    return { row, m, guest: only.email };
  };

  /** MEET-02 rules 19 and 26: the best other time on the same day, or on another day of the period. */
  r.post("/meetings/occurrences/:eventId/reschedule", async (c) => {
    const user = c.get("user");
    const { option } = await jsonBody(c, z.object({ option: z.enum(["sameDay", "otherDay"]) }));
    const { row: found, m, guest } = occurrence(c.req.param("eventId"), user);
    const markers = getSettings(db, m.user_id).markers;
    const result = await sync.exclusive(m.user_id, async (pool) => {
      // Read in the queue, so a plan run cannot move it in between.
      const row = one<ManagedRow>(db, "SELECT * FROM managed_events WHERE id = ?", found.id);
      if (!row?.event_id) return "missing" as const;
      if (row.start_ms <= now()) return "started" as const;
      // Accounts rule 16: a meeting on a disconnected account waits.
      const waiting = waitingCalendars(
        db,
        m.user_id,
      )(readEventSettings(m.event_settings, defaultEventSettings("meeting")).calendarId);
      if (waiting) return { waiting };
      const slot = rescheduleSlot(db, m.user_id, row, option, now());
      if (!slot) return "none" as const;
      const busy = row.busy === 1;
      // Rule 19: the result stays unlocked; the next plan sets free or busy.
      const title = row.user_edited
        ? row.title
        : withState(markers, m.title, busy ? "busy" : "free");
      const ev = await pool
        .get(found.account_id)
        .editExternal(
          found.provider_id,
          row.event_id,
          { summary: title, start: slot.start, end: slot.end, busy },
          row.etag,
        );
      cacheEvent(db, row.calendar_id, ev);
      run(
        db,
        "UPDATE managed_events SET start_ms = ?, end_ms = ?, title = ?, locked = 0, etag = ? WHERE id = ?",
        slot.start,
        slot.end,
        title,
        ev.etag,
        row.id,
      );
      logChange(
        db,
        m.user_id,
        {
          meetingId: m.id,
          key: row.key,
          oldStart: row.start_ms,
          oldEnd: row.end_ms,
          newStart: slot.start,
          newEnd: slot.end,
          actor: guest ? "attendee" : "organizer",
          reason: "manualMove",
          detail: guest ?? "",
          written: true,
        },
        now(),
      );
      return "ok" as const;
    });
    if (result === "missing") notFound("occurrence");
    if (result === "started") return c.json({ error: "started" }, 409);
    if (typeof result === "object")
      return c.json({ error: "waiting", message: waitingNote(result.waiting) }, 409);
    if (result === "none")
      return c.json({ error: "no_time", message: "No other time fits in this period." }, 409);
    changed(m.user_id);
    return c.json({ ok: true });
  });

  /**
   * MEET-02 rules 20 and 26: the organizer, or the guest of a 1:1, skips one
   * period; nothing else is placed in it. An occurrence that started stays.
   */
  r.post("/meetings/occurrences/:eventId/skip", (c) => {
    const user = c.get("user");
    const { row, m, guest } = occurrence(c.req.param("eventId"), user);
    if (row.start_ms <= now()) return c.json({ error: "started" }, 409);
    tx(db, () => {
      run(
        db,
        "INSERT OR IGNORE INTO dismissed_keys (user_id, key) VALUES (?, ?)",
        m.user_id,
        row.key,
      );
      if (guest)
        logChange(
          db,
          m.user_id,
          {
            meetingId: m.id,
            key: row.key,
            oldStart: row.start_ms,
            oldEnd: row.end_ms,
            newStart: null,
            newEnd: null,
            actor: "attendee",
            reason: "manualSkip",
            detail: guest,
            written: true,
          },
          now(),
        );
    });
    changed(m.user_id);
    return c.json({ ok: true });
  });

  /** MEET-02 rule 28: delete, and email the guests about the cancelled times only when asked (?notify=1). */
  r.delete("/meetings/:id", async (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const peers = meetingPeers(db, user.id).attendees;
    // Rules on an adopted series leave the series on the calendar: nothing to cancel.
    const notify = c.req.query("notify") === "1" && !adopted(m);
    const guests = attendeesOf(db, m.id)
      .map((a) => a.email)
      .filter((e) => e !== user.email);
    const times = await sync.exclusive(user.id, async (pool) => {
      // Read in the queue, so a plan run cannot move them in between.
      const future = all<{ start_ms: number; end_ms: number }>(
        db,
        `SELECT start_ms, end_ms FROM managed_events
         WHERE user_id = ? AND kind = 'meeting' AND source_id = ? AND start_ms > ?
           AND event_id IS NOT NULL ORDER BY start_ms`,
        user.id,
        m.id,
        now(),
      );
      // Read again in the queue, so a series that a plan run just wrote is ended too.
      const cur = own(m.id, user.id);
      if (adopted(cur)) await releaseSeries(db, pool, cur);
      else await endOwnSeries(db, (id) => pool.get(id), cur, now(), []);
      run(db, "DELETE FROM meetings WHERE id = ?", m.id);
      dropItemHours(db, m.hours_set_id);
      return future.map((o) => ({ start: o.start_ms, end: o.end_ms }));
    });
    sync.request(user.id);
    for (const id of peers) sync.request(id);
    if (notify && mailer) {
      notifyMeetingCancelled(mailer, {
        organizer: user.email,
        title: m.title,
        zone: homeZone(db, user.id),
        times,
        guests,
      });
    }
    return c.body(null, 204);
  });
  return r;
}
