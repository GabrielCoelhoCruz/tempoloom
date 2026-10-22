// Actions on one event from the planner (planning-planner.md PLN-11): make a
// habit from a recurring event, reschedule a habit occurrence, and what the
// details panel needs to offer them (habits-automation.md rules 6, 8, 30).
import { type Context, Hono } from "hono";
import { z } from "zod";
import { HabitChoice } from "../../shared/habit-choice.ts";
import { chosenMinute, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import type { ManagedRow } from "../planner/push.ts";
import type { SyncService } from "../sync/service.ts";
import { planningZone } from "../travel.ts";
import { badRequest, hhmm } from "./items.ts";
import { assignmentOf } from "./task-searches.ts";

const pad = (n: number) => String(n).padStart(2, "0");

export interface SeriesInfo {
  /** "guests": the series has other attendees, so it can be a flexible meeting instead. */
  eligible: boolean;
  reason: "guests" | null;
  title: string;
  idealTime: string;
  minutes: number;
  days: number[];
}

/**
 * Rule 8: a recurring external event of the user's own. Tempoloom decision:
 * the length goes up to the next 15 minutes; the days are the weekdays of the
 * series' occurrences in the event cache; the original series stays as it is.
 */
function seriesInfo(db: Db, userId: string, plannerId: string): SeriesInfo | null {
  if (!plannerId.startsWith("ext:")) return null;
  const rest = plannerId.slice(4);
  const cut = rest.indexOf(":");
  const ev = one<{
    calendar_id: string;
    summary: string;
    start_ms: number;
    end_ms: number;
    recurring_id: string | null;
    attendees: string;
  }>(
    db,
    `SELECT e.calendar_id, e.summary, e.start_ms, e.end_ms, e.recurring_id, e.attendees
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
    userId,
    rest.slice(0, cut),
    rest.slice(cut + 1),
  );
  if (!ev?.recurring_id) return null;
  const user = one<{ email: string; time_zone: string }>(
    db,
    "SELECT email, time_zone FROM users WHERE id = ?",
    userId,
  );
  const mine = new Set(
    [
      user?.email ?? "",
      ...all<{ email: string }>(db, "SELECT email FROM accounts WHERE user_id = ?", userId).map(
        (a) => a.email,
      ),
    ].map((e) => e.toLowerCase()),
  );
  const others = (JSON.parse(ev.attendees) as string[]).filter((a) => !mine.has(a.toLowerCase()));
  const zone = user?.time_zone ?? "UTC";
  const days = [
    ...new Set(
      all<{ start_ms: number }>(
        db,
        "SELECT start_ms FROM events WHERE calendar_id = ? AND recurring_id = ?",
        ev.calendar_id,
        ev.recurring_id,
      ).map((o) => weekdayOf(utcToLocal(zone, o.start_ms).date)),
    ),
  ].sort((a, b) => a - b);
  const start = utcToLocal(zone, ev.start_ms).minuteOfDay;
  const minutes = Math.max(15, Math.ceil((ev.end_ms - ev.start_ms) / 60_000 / 15) * 15);
  return {
    eligible: others.length === 0,
    reason: others.length === 0 ? null : "guests",
    title: ev.summary,
    idealTime: `${pad(Math.floor(start / 60))}:${pad(start % 60)}`,
    minutes,
    days,
  };
}

export function eventActionRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/habits/from-event", (c) => {
    const info = seriesInfo(db, c.get("user").id, c.req.query("id") ?? "");
    if (!info) notFound("series");
    return c.json({ series: info });
  });

  /**
   * The chosen time of one occurrence, on the day its event is on (rules 30,
   * 31: "the same day"). The event of an occurrence can be on another day than
   * its date (rule 14, or a move by hand). `minute` counts from the occurrence
   * date (chosenMinute). The day and the instant use the planning zone, as the
   * planner does (a travel zone on its dates).
   */
  const occurrenceTime = async (c: Context<AppEnv>, id: string) => {
    const user = c.get("user");
    const body = await jsonBody(c, z.object({ date: z.iso.date(), time: hhmm }));
    if (!one(db, "SELECT 1 FROM habits WHERE id = ? AND user_id = ?", id, user.id))
      notFound("habit");
    const [h, m] = body.time.split(":").map(Number) as [number, number];
    const event = one<{ start_ms: number; end_ms: number }>(
      db,
      "SELECT start_ms, end_ms FROM managed_events WHERE user_id = ? AND key = ?",
      user.id,
      `habit:${id}:${body.date}`,
    );
    const zone = planningZone(db, user.id, user.time_zone);
    const day = event ? utcToLocal(zone, event.start_ms).date : body.date;
    return { user, zone, event, date: body.date, minute: chosenMinute(body.date, day, h * 60 + m) };
  };

  /**
   * Stores the chosen time of one occurrence. A locked occurrence follows the
   * new choice (Tempoloom decision: reschedule and snooze unlock it); `from`:
   * only an occurrence that starts after it is unlocked. Tempoloom decision:
   * the occurrence is no longer started (PRG-3), so in manual start mode a
   * snoozed occurrence that nobody starts again goes back to the plan.
   */
  const saveTime = (
    userId: string,
    id: string,
    o: { date: string; minute: number },
    notBefore: boolean,
    from: number,
  ) => {
    run(
      db,
      `INSERT INTO habit_reschedules (user_id, habit_id, date, minute, not_before) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (habit_id, date) DO UPDATE SET minute = excluded.minute, not_before = excluded.not_before`,
      userId,
      id,
      o.date,
      o.minute,
      notBefore ? HabitChoice.snooze : HabitChoice.reschedule,
    );
    run(
      db,
      "UPDATE managed_events SET locked = 0, user_edited = 0, started = 0 WHERE user_id = ? AND key = ? AND start_ms > ?",
      userId,
      `habit:${id}:${o.date}`,
      from,
    );
    sync.request(userId, 0);
  };

  /** Rule 30: the occurrence goes to the legal slot nearest the chosen time on its day. */
  r.post("/habits/:id/reschedule", async (c) => {
    const id = c.req.param("id");
    const o = await occurrenceTime(c, id);
    saveTime(o.user.id, id, o, false, now());
    return c.json({ ok: true });
  });

  /**
   * Rule 31: the occurrence goes to the first legal slot at or after the
   * chosen time on its day. Tempoloom decision: the time must be after the
   * occurrence's current start (an earlier time is not a snooze) and not in
   * the past. A snooze is a user action, so it also moves an occurrence that
   * has started (see plan.ts snoozedLater).
   */
  r.post("/habits/:id/snooze", async (c) => {
    const id = c.req.param("id");
    const o = await occurrenceTime(c, id);
    const at = localToUtc(o.zone, o.date, o.minute);
    // A panel opened before the end: an ended occurrence keeps its done time.
    if (o.event && o.event.end_ms <= now()) badRequest("time", "The occurrence has ended");
    if (o.event && at <= o.event.start_ms)
      badRequest("time", "Pick a time after the occurrence's current start");
    if (at < now()) badRequest("time", "Pick a time that is not in the past");
    saveTime(o.user.id, id, o, true, Number.NEGATIVE_INFINITY);
    return c.json({ ok: true });
  });

  /** What the planner's details panel offers for one event. */
  r.get("/event-actions/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (id.startsWith("ext:"))
      return c.json({ kind: "external", series: seriesInfo(db, user.id, id) });
    const row = one<ManagedRow>(
      db,
      "SELECT * FROM managed_events WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    if (!row) notFound("event");
    const ended = row.end_ms <= now();
    return c.json({
      kind: row.kind,
      sourceId: row.source_id,
      date: row.key.split(":")[2] ?? null,
      // The zone of the times the forms show and send (occurrenceTime).
      zone: planningZone(db, user.id, user.time_zone),
      ended,
      started: row.start_ms <= now(),
      // Start when placed (rule 33): an occurrence is done when its end passes.
      done: row.kind === "habit" && ended,
      search: assignmentOf(db, user.id, row.kind, row.source_id),
    });
  });

  return r;
}
