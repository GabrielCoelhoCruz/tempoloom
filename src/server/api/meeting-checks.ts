// Meeting checks and their settings (automations-meeting-quality.md), the
// recommendations list (platform-current-version.md rule 5), meeting
// preferences (start times, meeting emails) and the weekly no-meeting day
// (events-tags.md rules 5-6, automations-library.md entry 33).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { ReportEntry } from "../../scheduler/model.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { scheduleDaily } from "../daily-mail.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { companyChecks, evaluate, HORIZON, openIssues } from "../meeting-checks.ts";
import { CHECK_IDS, getPrefs, updatePrefs } from "../meeting-prefs.ts";
import { writeCalendar } from "../planner/replan.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";

const conditions = z
  .object({
    minAttendees: z.number().int().min(2).max(500).optional(),
    descriptionEmpty: z.boolean().optional(),
    noVideoLink: z.boolean().optional(),
    externalGuests: z.boolean().optional(),
    longerThanMinutes: z.number().int().min(5).max(1440).optional(),
    titleContains: z.string().trim().min(1).max(100).optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined && v !== false), {
    message: "Set at least one condition",
  });

function adminTeam(db: Db, userId: string): string | null {
  return (
    one<{ team_id: string }>(
      db,
      "SELECT team_id FROM team_members WHERE user_id = ? AND role = 'admin'",
      userId,
    )?.team_id ?? null
  );
}

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const NO_MEETING_TITLE = "No meetings #tl_free";

/** Minutes of meetings per local day, overlaps counted once. */
function meetingMinutes(
  zone: string,
  spans: { start: number; end: number }[],
): Map<LocalDate, number> {
  const out = new Map<LocalDate, number>();
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let cur: { start: number; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    // Split at local midnights.
    let t = cur.start;
    while (t < cur.end) {
      const date = utcToLocal(zone, t).date;
      const next = Math.min(cur.end, localToUtc(zone, addDays(date, 1), 0));
      out.set(date, (out.get(date) ?? 0) + (next - t) / 60_000);
      t = next;
    }
  };
  for (const s of sorted) {
    if (cur && s.start <= cur.end) cur.end = Math.max(cur.end, s.end);
    else {
      flush();
      cur = { ...s };
    }
  }
  flush();
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const minutesText = (m: number) => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
};
const localText = (zone: string, t: number) => {
  const l = utcToLocal(zone, t);
  return `${l.date} ${pad(Math.floor(l.minuteOfDay / 60))}:${pad(l.minuteOfDay % 60)}`;
};

/** Tempoloom decision: a day with 6 hours of meetings or more is too full. */
const HEAVY_DAY_MINUTES = 360;

export interface Recommendation {
  kind: "habit" | "focus" | "task" | "meeting" | "heavy_day";
  text: string;
  date: string | null;
}

export function recommendations(db: Db, userId: string, now: number): Recommendation[] {
  const zone =
    one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", userId)?.time_zone ??
    "UTC";
  const report = JSON.parse(
    one<{ report: string }>(db, "SELECT report FROM plan_reports WHERE user_id = ?", userId)
      ?.report ?? "[]",
  ) as ReportEntry[];
  const title = (table: string, id: string) =>
    one<{ title: string }>(db, `SELECT title FROM ${table} WHERE id = ?`, id)?.title ?? "";
  const out: Recommendation[] = [];
  for (const e of report) {
    const date = e.demandKey.split(":")[2] ?? null;
    if (e.itemKind === "habit") {
      out.push({
        kind: "habit",
        date,
        text: `${title("habits", e.itemId)} was ${e.status === "conflict" ? "kept in conflict" : "skipped"} on ${date}`,
      });
    } else if (e.itemKind === "focus") {
      out.push({
        kind: "focus",
        date,
        text: `${title("focus_goals", e.itemId)} is ${minutesText(e.missingMinutes)} short of its goal in the week of ${date}`,
      });
    } else if (e.itemKind === "task") {
      out.push({
        kind: "task",
        date: null,
        text:
          e.status === "after-due"
            ? `${title("tasks", e.itemId)} ends after its due date`
            : `${title("tasks", e.itemId)} has ${minutesText(e.missingMinutes)} without time`,
      });
    } else if (e.itemKind === "meeting") {
      out.push({
        kind: "meeting",
        date,
        text: `${title("meetings", e.itemId)} ${e.status === "conflict" ? "is kept in conflict" : "has no time"} in the period of ${date}`,
      });
    }
  }
  // Days with too many meetings in the next 7 days.
  const user = one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId);
  const spans = all<{
    start_ms: number;
    end_ms: number;
    attendees: string;
    self_response: string | null;
    organizer_self: number;
  }>(
    db,
    `SELECT e.start_ms, e.end_ms, e.attendees, e.self_response, e.organizer_self
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1 AND e.all_day = 0
       AND e.busy = 1 AND e.end_ms > ? AND e.start_ms < ?`,
    userId,
    now,
    now + HORIZON,
  )
    .filter(
      (e) =>
        (JSON.parse(e.attendees) as string[]).some((a) => a !== user?.email.toLowerCase()) &&
        e.self_response !== "declined" &&
        (e.organizer_self === 1 || e.self_response !== "needsAction"),
    )
    .map((e) => ({ start: e.start_ms, end: e.end_ms }));
  for (const [date, minutes] of [...meetingMinutes(zone, spans)].sort()) {
    if (minutes >= HEAVY_DAY_MINUTES)
      out.push({
        kind: "heavy_day",
        date,
        text: `${date} has ${minutesText(minutes)} of meetings`,
      });
  }
  return out;
}

export function meetingCheckRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const zoneOf = (userId: string) =>
    one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", userId)?.time_zone ??
    "UTC";

  r.get("/meeting-checks", (c) => {
    const user = c.get("user");
    const next = one<{ next_at: number }>(
      db,
      "SELECT next_at FROM daily_mail WHERE user_id = ? AND kind = 'checks'",
      user.id,
    )?.next_at;
    return c.json({
      prefs: getPrefs(db, user.id),
      company: companyChecks(db, user.id),
      admin: adminTeam(db, user.id) !== null,
      nextDigest: next ? localText(zoneOf(user.id), next) : null,
    });
  });

  r.patch("/meeting-prefs", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, z.record(z.string(), z.unknown()));
    const before = getPrefs(db, user.id);
    let prefs: ReturnType<typeof getPrefs>;
    try {
      prefs = updatePrefs(db, user.id, body);
    } catch (err) {
      const message =
        err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid value") : String(err);
      return c.json({ error: "invalid_body", message }, 400);
    }
    // A new time takes effect at its next occurrence (today, if it is still ahead).
    const zone = zoneOf(user.id);
    if (prefs.digestTime !== before.digestTime || "digestTime" in body)
      scheduleDaily(db, user.id, "checks", zone, prefs.digestTime, now());
    if (prefs.dailyTime !== before.dailyTime || "dailyTime" in body)
      scheduleDaily(db, user.id, "daily", zone, prefs.dailyTime, now());
    sync.request(user.id);
    return c.json({ prefs });
  });

  r.get("/meeting-checks/issues", (c) =>
    c.json({ issues: openIssues(db, c.get("user").id, now()) }),
  );

  r.post("/meeting-checks/ignore", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        ignoreId: z.string().min(1).max(200),
        scope: z.enum(["event", "series"]),
        target: z.string().min(1).max(2000),
      }),
    );
    const known = new Set<string>([
      ...CHECK_IDS,
      ...companyChecks(db, user.id).map((x) => `company:${x.id}`),
    ]);
    if (!known.has(body.ignoreId)) notFound("check");
    run(
      db,
      `INSERT OR IGNORE INTO meeting_issue_ignores (user_id, check_id, scope, target, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      user.id,
      body.ignoreId,
      body.scope,
      body.target,
      now(),
    );
    return c.json({ ok: true });
  });

  /** Library entry 4: write the staged agenda draft into the event's description. */
  r.post("/meeting-checks/agenda", async (c) => {
    const user = c.get("user");
    const { eventKey } = await jsonBody(c, z.object({ eventKey: z.string() }));
    const found = evaluate(db, user.id, now()).find(
      (i) => i.checkId === "agenda" && i.eventKey === eventKey,
    );
    if (!found?.draft) notFound("issue");
    const draft = found.draft;
    const calendarId = eventKey.slice(0, eventKey.indexOf(":"));
    const eventId = eventKey.slice(eventKey.indexOf(":") + 1);
    await sync.exclusive(user.id, async (pool) => {
      const cal = one<{ account_id: string; provider_id: string }>(
        db,
        `SELECT c.account_id, c.provider_id FROM calendars c JOIN accounts a ON a.id = c.account_id
         WHERE c.id = ? AND a.user_id = ?`,
        calendarId,
        user.id,
      );
      if (!cal) notFound("calendar");
      const etag =
        one<{ etag: string | null }>(
          db,
          "SELECT etag FROM events WHERE calendar_id = ? AND event_id = ?",
          calendarId,
          eventId,
        )?.etag ?? null;
      const ev = await pool
        .get(cal.account_id)
        .editExternal(cal.provider_id, eventId, { description: draft }, etag);
      cacheEvent(db, calendarId, ev);
    });
    return c.json({ ok: true });
  });

  r.get("/meeting-checks/recommendations", (c) =>
    c.json({ recommendations: recommendations(db, c.get("user").id, now()) }),
  );

  // Company checks: team admins only (rules 8-11).
  r.post("/company-checks", async (c) => {
    const user = c.get("user");
    const team = adminTeam(db, user.id);
    if (!team) return c.json({ error: "forbidden" }, 403);
    const body = await jsonBody(
      c,
      z.object({ name: z.string().trim().min(1).max(100), conditions }),
    );
    const id = randomUUID();
    run(
      db,
      "INSERT INTO company_checks (id, team_id, name, conditions, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      id,
      team,
      body.name,
      JSON.stringify(body.conditions),
      now(),
    );
    return c.json({ id }, 201);
  });

  r.patch("/company-checks/:id", async (c) => {
    const team = adminTeam(db, c.get("user").id);
    if (!team) return c.json({ error: "forbidden" }, 403);
    const { enabled } = await jsonBody(c, z.object({ enabled: z.boolean() }));
    run(
      db,
      "UPDATE company_checks SET enabled = ? WHERE id = ? AND team_id = ?",
      enabled ? 1 : 0,
      c.req.param("id"),
      team,
    );
    return c.json({ ok: true });
  });

  r.delete("/company-checks/:id", (c) => {
    const team = adminTeam(db, c.get("user").id);
    if (!team) return c.json({ error: "forbidden" }, 403);
    run(db, "DELETE FROM company_checks WHERE id = ? AND team_id = ?", c.req.param("id"), team);
    return c.body(null, 204);
  });

  // The weekly no-meeting day: one weekly all-day busy event tagged #tl_free.
  r.get("/no-meeting-day", (c) => {
    const row = one<{ weekday: number }>(
      db,
      "SELECT weekday FROM no_meeting_days WHERE user_id = ?",
      c.get("user").id,
    );
    return c.json({ weekday: row?.weekday ?? null });
  });

  r.post("/no-meeting-day", async (c) => {
    const user = c.get("user");
    const { weekday } = await jsonBody(c, z.object({ weekday: z.number().int().min(1).max(7) }));
    if (one(db, "SELECT 1 FROM no_meeting_days WHERE user_id = ?", user.id))
      return c.json({ error: "exists", message: "Remove the current no-meeting day first." }, 409);
    const target = writeCalendar(db, user.id);
    if (!target) return c.json({ error: "no_calendar" }, 409);
    let first = utcToLocal(zoneOf(user.id), now()).date;
    while (weekdayOf(first) !== weekday) first = addDays(first, 1);
    await sync.exclusive(user.id, async (pool) => {
      const ev = await pool.get(target.account_id).insertEvent(target.provider_id, {
        summary: NO_MEETING_TITLE,
        description: "A weekly no-meeting day: tasks and habits may use it, meetings may not.",
        start: 0,
        end: 0,
        allDayDates: { start: first, end: addDays(first, 1) },
        recurrence: `FREQ=WEEKLY;BYDAY=${BYDAY[weekday - 1]}`,
        busy: true,
        colorId: null,
        privateProps: { tl_nomeeting: "1" },
      });
      cacheEvent(db, target.id, ev);
      run(
        db,
        "INSERT INTO no_meeting_days (user_id, weekday, calendar_id, event_id, created_at) VALUES (?, ?, ?, ?, ?)",
        user.id,
        weekday,
        target.id,
        ev.recurringId ?? ev.id,
        now(),
      );
    });
    return c.json({ ok: true }, 201);
  });

  r.delete("/no-meeting-day", async (c) => {
    const user = c.get("user");
    await sync.exclusive(user.id, async (pool) => {
      const row = one<{ calendar_id: string; event_id: string }>(
        db,
        "SELECT calendar_id, event_id FROM no_meeting_days WHERE user_id = ?",
        user.id,
      );
      if (!row) return;
      const cal = one<{ account_id: string; provider_id: string }>(
        db,
        "SELECT account_id, provider_id FROM calendars WHERE id = ?",
        row.calendar_id,
      );
      if (cal) await pool.get(cal.account_id).deleteEvent(cal.provider_id, row.event_id);
      run(
        db,
        "DELETE FROM events WHERE calendar_id = ? AND (event_id = ? OR recurring_id = ?)",
        row.calendar_id,
        row.event_id,
        row.event_id,
      );
      run(db, "DELETE FROM no_meeting_days WHERE user_id = ?", user.id);
    });
    return c.body(null, 204);
  });

  return r;
}
