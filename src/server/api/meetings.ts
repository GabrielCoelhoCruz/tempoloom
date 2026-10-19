// Flexible meetings (docs/specs/meetings-flexible.md, meetings-flexible-rescheduling.md).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { plan } from "../../scheduler/plan.ts";
import { addDays, type LocalDate, weekdayOf } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { adoptableSeries } from "../meeting-series.ts";
import { withState } from "../planner/markers.ts";
import { logChange } from "../planner/meeting-log.ts";
import {
  type Attendee,
  attendeesOf,
  instanceUser,
  type MeetingRow,
  meetingItem,
  meetingPeers,
} from "../planner/meetings.ts";
import { KEY_PROP, MANAGED_PROP, type ManagedRow } from "../planner/push.ts";
import { loadSnapshot } from "../planner/replan.ts";
import type { ProviderPool } from "../providers/index.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";
import { badRequest, hhmm, hoursSetId, nextRank } from "./items.ts";

const fiveMinutes = z.number().int().min(5).max(480).multipleOf(5);
const meetingInput = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(8000).default(""),
  location: z.string().max(500).default(""),
  attendees: z
    .array(z.object({ email: z.email(), required: z.boolean().default(true) }))
    .min(1)
    .max(50),
  frequency: z.discriminatedUnion("period", [
    z.object({ period: z.literal("daily") }),
    z.object({
      period: z.literal("weekly"),
      everyWeeks: z.number().int().min(1).max(52),
      idealDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    }),
  ]),
  idealTime: hhmm,
  durationMinutes: fiveMinutes,
  shortestMinutes: fiveMinutes.optional(),
  hoursMode: z.enum(["everyone", "organizer"]).default("everyone"),
  hoursSetId: z.string().optional(),
  starting: z.iso.date().nullable().default(null),
  level: z.number().int().min(1).max(4).default(2),
  defense: z.enum(["adaptive", "busy", "free"]).default("adaptive"),
  whenUnplaceable: z.enum(["remove", "keep_as_conflict"]).default("keep_as_conflict"),
  leadHours: z.number().int().min(0).max(168).default(12),
  autoReschedule: z.enum(["none", "conservative", "moderate", "aggressive"]).default("moderate"),
  /** Attach the rules to this recurring series (meetings-flexible.md rule 1). */
  series: z.object({ calendarId: z.string(), seriesId: z.string() }).optional(),
});
type MeetingInput = z.infer<typeof meetingInput>;

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
    .map((a) => ({ email: a.email.toLowerCase(), required: a.required }))
    .filter((a, i, list) => a.email !== email && list.findIndex((x) => x.email === a.email) === i);
  if (attendees.length === 0) badRequest("attendees", "Invite at least one other person");
  const shortest = b.shortestMinutes ?? b.durationMinutes;
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
      hours_mode: b.hoursMode,
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
    "series_calendar_id",
    "series_event_id",
  ] as const;
  const values = cols.map((k) => row[k]);
  if (insert) {
    run(
      db,
      `INSERT INTO meetings (id, user_id, created_at, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})`,
      row.id,
      row.user_id,
      row.created_at,
      ...values,
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
      "INSERT INTO meeting_attendees (meeting_id, email, required) VALUES (?, ?, ?)",
      row.id,
      a.email,
      a.required ? 1 : 0,
    );
  }
}

/** The guests, organizer and location written on each occurrence (rules 35, 41). */
export function guestsOf(db: Db, m: MeetingRow, organizer: string) {
  const people = attendeesOf(db, m.id).filter((a) => a.email !== organizer);
  return {
    organizer,
    attendees: people.filter((a) => a.required).map((a) => a.email),
    optionalAttendees: people.filter((a) => !a.required).map((a) => a.email),
    ...(m.location ? { location: m.location } : {}),
  };
}

function weekStartOf(db: Db, userId: string, date: LocalDate): LocalDate {
  const weekStart = getSettings(db, userId).weekStart;
  return addDays(date, -((weekdayOf(date) - weekStart + 7) % 7));
}

function seriesTarget(db: Db, m: MeetingRow) {
  return one<{ account_id: string; provider_id: string }>(
    db,
    "SELECT account_id, provider_id FROM calendars WHERE id = ?",
    m.series_calendar_id,
  );
}

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

export function meetingRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
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
    const meetings = all<MeetingRow>(
      db,
      "SELECT * FROM meetings WHERE user_id = ? ORDER BY level, rank, created_at",
      user.id,
    ).map((m) => ({
      ...m,
      frequency: JSON.parse(m.frequency) as unknown,
      attendees: attendeesOf(db, m.id).map((a) => ({ ...a, ...person(db, a.email) })),
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
      problems: report.filter((e) => e.itemKind === "meeting" && e.itemId === m.id),
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
    return c.json({ meetings });
  });

  /** Rule 1: the user's recurring series that rules can attach to. */
  r.get("/meetings/series", (c) =>
    c.json({ series: adoptableSeries(db, c.get("user").id, now()) }),
  );

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
    const { row, attendees } = rowFrom(db, user.id, "preview", body, t, 0);
    const zone =
      one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", user.id)
        ?.time_zone ?? "UTC";
    const last =
      one<{ planned_at: number }>(
        db,
        "SELECT planned_at FROM plan_reports WHERE user_id = ?",
        user.id,
      )?.planned_at ?? 0;
    const { snapshot } = loadSnapshot(db, user.id, zone, getSettings(db, user.id), t, last);
    const item = meetingItem(db, user.id, row, attendees, t, snapshot.windowEnd, last, new Map());
    const result = plan({ ...snapshot, meetings: [...snapshot.meetings, item] });
    const before = new Map(snapshot.current.map((p) => [p.key, p]));
    const moved = result.placements.filter((p) => {
      const b = before.get(p.key);
      return p.itemId !== "preview" && b && (b.start !== p.start || b.end !== p.end);
    }).length;
    return c.json({
      occurrences: result.placements
        .filter((p) => p.itemId === "preview")
        .slice(0, 4)
        .map((p) => ({ start: p.start, end: p.end, conflict: p.conflict })),
      problems: result.report.filter((e) => e.itemId === "preview").slice(0, 4),
      moved,
    });
  });

  r.post("/meetings", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, meetingInput);
    const id = randomUUID();
    const series = body.series
      ? adoptableSeries(db, user.id, now()).find(
          (x) => x.calendarId === body.series?.calendarId && x.seriesId === body.series.seriesId,
        )
      : undefined;
    if (body.series && !series) badRequest("series", "Pick a recurring meeting you organize");
    const { row, attendees } = rowFrom(
      db,
      user.id,
      id,
      body,
      now(),
      nextRank(db, "meetings", user.id, body.level),
    );
    if (series) {
      // An adopted series keeps its id; its instances are placed from the next sync on.
      const everyWeeks = body.frequency.period === "weekly" ? body.frequency.everyWeeks : 1;
      if (everyWeeks > 1) row.starting = weekStartOf(db, user.id, series.firstDate);
      await sync.exclusive(user.id, async (pool) => {
        await markSeries(db, pool, row, user.id);
        save(db, row, attendees, true);
      });
    } else {
      save(db, row, attendees, true);
    }
    changed(user.id);
    return c.json({ id }, 201);
  });

  r.put("/meetings/:id", async (c) => {
    const user = c.get("user");
    const old = own(c.req.param("id"), user.id);
    const body = await jsonBody(c, meetingInput);
    const { row, attendees } = rowFrom(db, user.id, old.id, body, now(), old.rank);
    save(
      db,
      {
        ...row,
        created_at: old.created_at,
        series_calendar_id: old.series_calendar_id,
        series_event_id: old.series_event_id,
      },
      attendees,
      false,
    );
    changed(user.id);
    return c.json({ ok: true });
  });

  /**
   * Rule 27 of MEET-02: off removes future occurrences and keeps the rules.
   * An adopted series stays as it is; Tempoloom only stops managing it (open question 1).
   */
  r.post("/meetings/:id/enabled", async (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const { enabled } = await jsonBody(c, z.object({ enabled: z.boolean() }));
    await sync.exclusive(user.id, async (pool) => {
      run(
        db,
        "UPDATE meetings SET enabled = ?, rules_changed_at = ? WHERE id = ?",
        enabled ? 1 : 0,
        now(),
        m.id,
      );
      if (m.series_event_id) {
        if (enabled) await markSeries(db, pool, m, user.id);
        else await releaseSeries(db, pool, m);
      }
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
      const ev = await pool.get(row.account_id).updateEvent(
        row.provider_id,
        row.event_id,
        {
          summary: title,
          description: row.description,
          start,
          end,
          busy: true,
          colorId: row.color_id,
          privateProps: { [MANAGED_PROP]: "1", [KEY_PROP]: row.key, tl_user: user.id },
          ...guestsOf(db, m, user.email),
        },
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

  /** MEET-02 rule 20: skip one period; nothing else is placed in it. */
  r.post("/meetings/:id/skip", async (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const { eventId } = await jsonBody(c, z.object({ eventId: z.string() }));
    const key = one<{ key: string }>(
      db,
      "SELECT key FROM managed_events WHERE id = ? AND user_id = ? AND kind = 'meeting' AND source_id = ?",
      eventId,
      user.id,
      m.id,
    )?.key;
    if (!key) notFound("occurrence");
    run(db, "INSERT OR IGNORE INTO dismissed_keys (user_id, key) VALUES (?, ?)", user.id, key);
    changed(user.id);
    return c.json({ ok: true });
  });

  r.delete("/meetings/:id", async (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const peers = meetingPeers(db, user.id).attendees;
    await sync.exclusive(user.id, async (pool) => {
      if (m.series_event_id) await releaseSeries(db, pool, m);
      run(db, "DELETE FROM meetings WHERE id = ?", m.id);
    });
    sync.request(user.id);
    for (const id of peers) sync.request(id);
    return c.body(null, 204);
  });
  return r;
}
