// Habit dependencies and the snooze of one occurrence at the API
// (habits-automation.md rules 18, 31).
//
// Ways it can fail:
// 1. A rule that closes a cycle (a before b, b before a; or through a third
//    habit) is stored, so the scheduler must drop one of the rules.
// 2. A snooze time at or before the occurrence's current start is stored: it
//    is not a snooze, and for a started occurrence it does nothing.
// 3. A snooze time in the past is stored.
// 4. A snooze or a reschedule of an occurrence whose event is on another day
//    (rule 14, or a move by hand) is stored for the occurrence date, so the
//    next run puts it back on that date (habits rule 30, 31: "same day").
// 5. A snooze of an occurrence the user started keeps it started, so in
//    manual start mode it does not come back to the plan when it is missed.
// 6. A snooze from a stale panel ends the started state of an ended occurrence.
// 7. During a trip the API reads the event's day in the home zone, so the
//    planner (planning zone) puts the occurrence one day off.
// 8. A run on a later day does not load the choice of a passed date, so the
//    occurrence leaves the plan and its event is deleted.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { plan } from "../../src/scheduler/plan.ts";
import { ensureUser } from "../../src/server/accounts.ts";
import { eventActionRoutes } from "../../src/server/api/event-actions.ts";
import { habitRoutes } from "../../src/server/api/habits.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import { loadSnapshot } from "../../src/server/planner/replan.ts";
import { getSettings, updateSettings } from "../../src/server/settings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

// Monday 2026-11-09, 12:05 UTC (the user's zone is UTC).
const NOW = Date.parse("2026-11-09T12:05:00Z");
const DATE = "2026-11-09";

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW);
  const sync = { request: () => {} } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    habitRoutes(db, sync, () => NOW),
  );
  app.route(
    "/api",
    eventActionRoutes(db, sync, () => NOW),
  );
  const send = (method: string, url: string, body: unknown) =>
    app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const habit = async (title: string) => {
    const res = await send("POST", "/api/habits", {
      title,
      idealTime: "12:00",
      minMinutes: 30,
      maxMinutes: 30,
    });
    return ((await res.json()) as { habit: { id: string } }).habit.id;
  };
  const depend = (id: string, target: string, rule = "before") =>
    send("PATCH", `/api/habits/${id}`, { dependencies: [{ rule, kind: "habit", id: target }] });
  return { db, user, send, habit, depend };
}

const message = async (res: Response) =>
  ((await res.json()) as { issues: { message: string }[] }).issues[0]?.message;

describe("dependency cycles are refused (rule 18)", () => {
  it("a before b, then b before a: 400 with a clear message, and nothing stored", async () => {
    const s = setup();
    const a = await s.habit("A");
    const b = await s.habit("B");
    expect((await s.depend(a, b)).status).toBe(200);
    const res = await s.depend(b, a, "not-after");
    expect(res.status).toBe(400);
    expect(await message(res)).toBe(
      "This rule makes a loop: A already depends on B, directly or through other habits",
    );
    expect(all(s.db, "SELECT dependencies FROM habits WHERE id = ?", b)).toEqual([
      { dependencies: "[]" },
    ]);
  });

  it("a cycle through a third habit is refused; a chain and a shared target are not", async () => {
    const s = setup();
    const [a, b, c] = [await s.habit("A"), await s.habit("B"), await s.habit("C")];
    expect((await s.depend(a, b)).status).toBe(200);
    expect((await s.depend(b, c, "not-same-day")).status).toBe(200);
    const res = await s.depend(c, a, "not-after");
    expect(res.status).toBe(400);
    expect(await message(res)).toBe(
      "This rule makes a loop: A already depends on C, directly or through other habits",
    );
    const d = await s.habit("D");
    expect((await s.depend(d, c)).status).toBe(200);
  });
});

describe("snooze one occurrence (rule 31)", () => {
  function started(
    s: ReturnType<typeof setup>,
    id: string,
    o: { date?: string; day?: string; flag?: number } = {},
  ) {
    const day = o.day ?? DATE;
    run(
      s.db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
       VALUES ('acc', ?, 'caldav', 'owner', 'owner@example.com', '', ?)`,
      s.user.id,
      NOW,
    );
    run(
      s.db,
      "INSERT INTO calendars (id, account_id, provider_id, name, is_primary) VALUES ('cal', 'acc', 'cal', 'Work', 1)",
    );
    run(
      s.db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title, locked, started)
       VALUES ('m1', ?, 'cal', 'e1', ?, 'habit', ?, ?, ?, 1, 'Lunch', ?, ?)`,
      s.user.id,
      `habit:${id}:${o.date ?? DATE}`,
      id,
      Date.parse(`${day}T12:00:00Z`),
      Date.parse(`${day}T12:30:00Z`),
      o.flag ?? 0,
      o.flag ?? 0,
    );
  }
  const stored = (s: ReturnType<typeof setup>) =>
    all(s.db, "SELECT date, minute, not_before FROM habit_reschedules");

  it("a time at or before the start of the occurrence that has started is refused", async () => {
    const s = setup();
    const id = await s.habit("Lunch");
    started(s, id);
    for (const time of ["11:00", "12:00"]) {
      const res = await s.send("POST", `/api/habits/${id}/snooze`, { date: DATE, time });
      expect(res.status).toBe(400);
      expect(await message(res)).toBe("Pick a time after the occurrence's current start");
    }
    expect(stored(s)).toEqual([]);
    const ok = await s.send("POST", `/api/habits/${id}/snooze`, { date: DATE, time: "12:15" });
    expect(ok.status).toBe(200);
    expect(stored(s)).toEqual([{ date: DATE, minute: 735, not_before: 1 }]);
  });

  it("a time in the past is refused for an occurrence with no event", async () => {
    const s = setup();
    const id = await s.habit("Lunch");
    const res = await s.send("POST", `/api/habits/${id}/snooze`, { date: DATE, time: "12:00" });
    expect(res.status).toBe(400);
    expect(await message(res)).toBe("Pick a time that is not in the past");
    expect(stored(s)).toEqual([]);
  });

  it("a snooze or a reschedule keeps the day the event moved to", async () => {
    // The Wednesday occurrence runs on Thursday at 12:00.
    const s = setup();
    const id = await s.habit("Lunch");
    started(s, id, { date: "2026-11-11", day: "2026-11-12" });
    const at = (time: string) => ({ date: "2026-11-11", time });
    // 13:00 on Thursday is after the start: not refused as 13:00 on Wednesday would be.
    expect((await s.send("POST", `/api/habits/${id}/snooze`, at("13:00"))).status).toBe(200);
    expect(stored(s)).toEqual([{ date: "2026-11-11", minute: 1440 + 780, not_before: 1 }]);
    expect((await s.send("POST", `/api/habits/${id}/reschedule`, at("10:00"))).status).toBe(200);
    expect(stored(s)).toEqual([{ date: "2026-11-11", minute: 1440 + 600, not_before: 0 }]);
    // An occurrence with no event keeps its own date.
    const other = await s.habit("Walk");
    const res = await s.send("POST", `/api/habits/${other}/snooze`, at("09:00"));
    expect(res.status).toBe(200);
    expect(all(s.db, "SELECT minute FROM habit_reschedules WHERE habit_id = ?", other)).toEqual([
      { minute: 540 },
    ]);
  });

  it("a snooze of a started occurrence makes it not started again (manual start mode)", async () => {
    const s = setup();
    const id = await s.habit("Lunch");
    started(s, id, { flag: 1 });
    const res = await s.send("POST", `/api/habits/${id}/snooze`, { date: DATE, time: "12:15" });
    expect(res.status).toBe(200);
    expect(all(s.db, "SELECT started, locked FROM managed_events")).toEqual([
      { started: 0, locked: 0 },
    ]);
    // Nobody starts it, and it ends where it was (no run moved it): a run at
    // 13:00 in manual start mode places it again later that day (PRG-3, rule 33).
    updateSettings(s.db, s.user.id, { startMode: "manual", manualSince: 0 });
    const later = Date.parse(`${DATE}T13:00:00Z`);
    const { snapshot, reopen } = loadSnapshot(
      s.db,
      s.user.id,
      "UTC",
      getSettings(s.db, s.user.id),
      later,
      0,
    );
    expect(reopen.map((r) => r.id)).toEqual(["m1"]);
    const placed = plan(snapshot).placements.find((p) => p.key === `habit:${id}:${DATE}`);
    expect(placed && placed.start >= later).toBe(true);
    expect(placed && new Date(placed.start).toISOString().slice(0, 10)).toBe(DATE);
  });

  it("a snooze of an occurrence that has ended is refused and keeps it started", async () => {
    const s = setup();
    const id = await s.habit("Lunch");
    // Started at 11:00 and ended at 11:30; the panel was opened before the end.
    started(s, id, { flag: 1 });
    run(
      s.db,
      "UPDATE managed_events SET start_ms = ?, end_ms = ?",
      Date.parse(`${DATE}T11:00:00Z`),
      Date.parse(`${DATE}T11:30:00Z`),
    );
    const res = await s.send("POST", `/api/habits/${id}/snooze`, { date: DATE, time: "13:00" });
    expect(res.status).toBe(400);
    expect(await message(res)).toBe("The occurrence has ended");
    expect(all(s.db, "SELECT started, locked FROM managed_events")).toEqual([
      { started: 1, locked: 1 },
    ]);
    expect(stored(s)).toEqual([]);
  });

  it("the event's day is read in the planning zone during a trip, as the planner does", async () => {
    const s = setup();
    const id = await s.habit("Lunch");
    // The trip is in New York: the event at 01:00 UTC Thursday is 20:00 Wednesday there.
    run(
      s.db,
      `INSERT INTO travel_zones (id, user_id, tz, start_date, end_date, created_at)
       VALUES ('t1', ?, 'America/New_York', '2026-11-01', '2026-11-30', ?)`,
      s.user.id,
      NOW,
    );
    started(s, id, { date: "2026-11-11" });
    run(
      s.db,
      "UPDATE managed_events SET start_ms = ?, end_ms = ?",
      Date.parse("2026-11-12T01:00:00Z"),
      Date.parse("2026-11-12T01:30:00Z"),
    );
    const res = await s.send("POST", `/api/habits/${id}/snooze`, {
      date: "2026-11-11",
      time: "21:00",
    });
    expect(res.status).toBe(200);
    expect(stored(s)).toEqual([{ date: "2026-11-11", minute: 1260, not_before: 1 }]);
  });
});

describe("chosen times load by their day (rules 30, 31)", () => {
  it("a run on a later day loads the choice of a passed date on that day, not one on the passed date", async () => {
    const s = setup();
    const id = await s.habit("Lunch");
    const walk = await s.habit("Walk");
    // Monday's occurrences: Lunch moved to Tuesday 10:00, Walk to Monday 15:00.
    for (const [habit, minute] of [
      [id, 1440 + 600],
      [walk, 900],
    ] as const)
      run(
        s.db,
        "INSERT INTO habit_reschedules (user_id, habit_id, date, minute, not_before) VALUES (?, ?, ?, ?, 0)",
        s.user.id,
        habit,
        DATE,
        minute,
      );
    const tuesday = Date.parse("2026-11-10T08:00:00Z");
    const { snapshot } = loadSnapshot(
      s.db,
      s.user.id,
      "UTC",
      getSettings(s.db, s.user.id),
      tuesday,
      0,
    );
    const choices = Object.fromEntries(snapshot.habits.map((h) => [h.title, h.rescheduled]));
    expect(choices).toEqual({ Lunch: { [DATE]: 1440 + 600 }, Walk: undefined });
    const placed = plan(snapshot).placements.find((p) => p.key === `habit:${id}:${DATE}`);
    expect(placed && new Date(placed.start).toISOString()).toBe("2026-11-10T10:00:00.000Z");
  });
});
