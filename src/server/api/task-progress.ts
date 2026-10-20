// Task progress by hand (planning-task-progress.md): Start and Stop (PRG-4,
// PRG-10, PRG-11, edge cases 1 to 4) and logged work (PRG-20 to PRG-22,
// habits-automation.md rule 32).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { MINUTE } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { logChange } from "../change-log.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { externalEvents } from "../planner/events.ts";
import { eventTitle, placementState, withState } from "../planner/markers.ts";
import { openTasks } from "../planner/now.ts";
import { type ManagedRow, rowWrite } from "../planner/push.ts";
import { eventDescription, writeCalendar } from "../planner/replan.ts";
import { insertLocked, nextChunkIndex, writableCalendar, writeLocked } from "../planner/write.ts";
import type { ProviderPool } from "../providers/index.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";

const FIVE = 5 * MINUTE;
const LOCKED = { locked: true, conflict: false, busy: true } as const;

type Row = ManagedRow & { account_id: string; provider_id: string };

/** A change-log entry for one Start or Stop (support-troubleshooting.md rule 12). */
const change = (
  row: Row,
  eventId: string,
  action: "update" | "delete",
  reason: string,
  title: string,
  start: number,
  end: number,
) => ({
  calendarId: row.calendar_id,
  eventId,
  key: row.key,
  action,
  item: `${row.kind}:${row.source_id}`,
  reason,
  title,
  start,
  end,
});

export function taskProgressRoutes(
  db: Db,
  sync: SyncService,
  baseUrl: string,
  now: () => number,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const chunks = (userId: string, taskId: string) =>
    all<Row>(
      db,
      `SELECT m.*, c.account_id, c.provider_id FROM managed_events m JOIN calendars c ON c.id = m.calendar_id
       WHERE m.user_id = ? AND m.kind = 'task' AND m.source_id = ? AND m.event_id IS NOT NULL
         AND m.end_ms > ? ORDER BY m.start_ms`,
      userId,
      taskId,
      now(),
    );

  /** Edge case 3: the new time ends at the first busy external event it meets. */
  const firstConflict = (userId: string, start: number, end: number) =>
    externalEvents(db, userId, start, end)
      .filter((e) => e.busy && !e.allDay && e.selfResponse !== "declined" && e.start > start)
      .reduce((m, e) => Math.min(m, e.start), end);

  /** The etag of the event as last read, else the one Tempoloom wrote. */
  const etagOf = (row: Row) =>
    one<{ etag: string | null }>(
      db,
      "SELECT etag FROM events WHERE calendar_id = ? AND event_id = ?",
      row.calendar_id,
      row.event_id,
    )?.etag ?? row.etag;

  /**
   * Writes a started managed event at a new time, locked (CED-50 style). The
   * caller holds the user's sync queue, so the row and its etag are current.
   */
  const retime = async (
    pool: ProviderPool,
    userId: string,
    row: Row,
    start: number,
    end: number,
    reason: string,
  ) => {
    if (!row.event_id) return;
    const markers = getSettings(db, userId).markers;
    const title = row.user_edited ? row.title : withState(markers, row.title, "locked");
    const ev = await pool
      .get(row.account_id)
      .updateEvent(
        row.provider_id,
        row.event_id,
        rowWrite(userId, row, { start, end, title, busy: true }),
        etagOf(row),
      );
    cacheEvent(db, row.calendar_id, ev);
    logChange(db, userId, change(row, row.event_id, "update", reason, title, start, end), now());
    run(
      db,
      "UPDATE managed_events SET start_ms = ?, end_ms = ?, title = ?, busy = 1, locked = 1, started = 1, etag = ? WHERE id = ?",
      start,
      end,
      title,
      ev.etag,
      row.id,
    );
  };

  /**
   * Start on one event, inside the user's sync queue. PRG-10: a later event
   * moves to now, rounded down to 5 minutes, with its length. PRG-4: in manual
   * mode a running event starts now. Edge case 2: in auto mode a running event
   * does not change. Either way the event is started (PRG-3) and gets the lock.
   */
  const startRow = async (pool: ProviderPool, userId: string, row: Row) => {
    const t = now();
    const at = Math.floor(t / FIVE) * FIVE;
    const running = row.start_ms <= t;
    const move = !running || (getSettings(db, userId).startMode === "manual" && at > row.start_ms);
    if (!move) {
      run(db, "UPDATE managed_events SET locked = 1, started = 1 WHERE id = ?", row.id);
      return;
    }
    const end = firstConflict(userId, at, at + (row.end_ms - row.start_ms));
    await retime(pool, userId, row, at, end, "started");
  };

  r.post("/tasks/:id/start", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    // The row, its etag and a new chunk key are read inside the sync queue, so
    // a plan run or a second Start in between cannot make them stale.
    const result = await sync.exclusive(user.id, async (pool) => {
      const task = openTasks(db, user.id, now()).find((t) => t.id === id);
      if (!task) return "not_found" as const;
      const first = chunks(user.id, id)[0];
      if (first) {
        await startRow(pool, user.id, first);
        return "ok" as const;
      }
      // Edge case 1: no chunk to move, so one starts now.
      const it = one<{ title: string; notes: string; max_chunk_minutes: number }>(
        db,
        "SELECT title, notes, max_chunk_minutes FROM tasks WHERE id = ?",
        id,
      );
      const minutes = Math.min(task.remaining, it?.max_chunk_minutes ?? 0);
      const calendarId = writeCalendar(db, user.id)?.id;
      if (!it || minutes <= 0 || !calendarId) return "nothing" as const;
      const at = Math.floor(now() / FIVE) * FIVE;
      await insertLocked(db, pool, user.id, calendarId, [
        {
          key: `task:${id}:${nextChunkIndex(db, user.id, id)}`,
          kind: "task",
          sourceId: id,
          start: at,
          end: firstConflict(user.id, at, at + minutes * MINUTE),
          title: eventTitle(getSettings(db, user.id).markers, {
            state: placementState("task", LOCKED),
            title: it.title,
          }),
          description: eventDescription(it.notes, baseUrl, "task", id),
          started: true,
        },
      ]);
      return "ok" as const;
    });
    if (result === "not_found") notFound("task");
    if (result === "nothing")
      return c.json({ error: "nothing_to_start", message: "No work is left on this task." }, 409);
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  /** PRG-11: the running chunk ends now; the rest goes back to the plan. */
  r.post("/tasks/:id/stop", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const stopped = await sync.exclusive(user.id, async (pool) => {
      const t = now();
      const row = chunks(user.id, id).find((ch) => ch.start_ms <= t);
      if (!row?.event_id) return false;
      const end = Math.round(t / MINUTE) * MINUTE;
      if (end - row.start_ms >= FIVE) {
        await retime(pool, user.id, row, row.start_ms, end, "stopped");
        return true;
      }
      // Edge case 4: a stop within 5 minutes returns the whole chunk.
      const eventId = row.event_id;
      await pool.get(row.account_id).deleteEvent(row.provider_id, eventId);
      run(
        db,
        "DELETE FROM events WHERE calendar_id = ? AND event_id = ?",
        row.calendar_id,
        eventId,
      );
      run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
      logChange(
        db,
        user.id,
        change(row, eventId, "delete", "stopped", row.title, row.start_ms, row.end_ms),
        now(),
      );
      return true;
    });
    if (!stopped)
      return c.json({ error: "not_running", message: "No chunk of this task is running." }, 409);
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  /** Start on one task chunk or habit event from the planner (PRG-4, PRG-5, PRG-10). */
  r.post("/planner/events/:id/start", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const result = await sync.exclusive(user.id, async (pool) => {
      const row = one<Row>(
        db,
        `SELECT m.*, c.account_id, c.provider_id FROM managed_events m JOIN calendars c ON c.id = m.calendar_id
         WHERE m.id = ? AND m.user_id = ? AND m.kind IN ('task', 'habit') AND m.event_id IS NOT NULL`,
        id,
        user.id,
      );
      if (!row) return "not_found" as const;
      if (row.end_ms <= now()) return "ended" as const;
      await startRow(pool, user.id, row);
      return "ok" as const;
    });
    if (result === "not_found") notFound("event");
    if (result === "ended") return c.json({ error: "event_ended" }, 409);
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  /**
   * PRG-20 to PRG-22, habits rule 32: work done outside the plan becomes a
   * past, locked event of the task or habit. A task's ended events are its
   * done work, so the remaining work goes down by the logged minutes.
   */
  r.post("/log-work", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        kind: z.enum(["task", "habit"]),
        itemId: z.string(),
        start: z.number().int(),
        minutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60),
      }),
    );
    const it = one<{ title: string; notes: string; hours_set_id: string }>(
      db,
      `SELECT title, notes, hours_set_id FROM ${body.kind === "task" ? "tasks" : "habits"} WHERE id = ? AND user_id = ?`,
      body.itemId,
      user.id,
    );
    if (!it) notFound(body.kind);
    const start = Math.floor(body.start / MINUTE) * MINUTE;
    const end = start + body.minutes * MINUTE;
    // Edge case 6: work in the future is not logged.
    if (end > now())
      return c.json(
        { error: "not_past", message: "Logged work must end in the past, not after now." },
        400,
      );
    const chosen =
      body.kind === "task"
        ? one<{ task_calendar_id: string | null }>(
            db,
            "SELECT task_calendar_id FROM hours_sets WHERE id = ?",
            it.hours_set_id,
          )?.task_calendar_id
        : null;
    const calendarId =
      (chosen ? writableCalendar(db, user.id, chosen)?.id : undefined) ??
      writeCalendar(db, user.id)?.id;
    if (!calendarId) notFound("calendar");
    await writeLocked(db, sync, user.id, calendarId, [
      {
        key: `${body.kind}:${body.itemId}:log-${randomUUID().slice(0, 8)}`,
        kind: body.kind,
        sourceId: body.itemId,
        start,
        end,
        title: it.title,
        description: eventDescription(it.notes, baseUrl, body.kind, body.itemId),
        started: true,
      },
    ]);
    sync.request(user.id, 0);
    return c.json({ ok: true }, 201);
  });

  return r;
}
