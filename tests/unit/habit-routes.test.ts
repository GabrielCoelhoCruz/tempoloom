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
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { eventActionRoutes } from "../../src/server/api/event-actions.ts";
import { habitRoutes } from "../../src/server/api/habits.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import { endedUnstarted, type ProgressRow } from "../../src/server/planner/progress.ts";
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
    const [row] = all<ProgressRow & { locked: number }>(s.db, "SELECT * FROM managed_events");
    expect(row).toMatchObject({ started: 0, locked: 0 });
    // When it is missed, it comes back to the plan (PRG-3, habits rule 33).
    const manual = { startMode: "manual" as const, manualSince: 0 };
    expect(row && endedUnstarted({ ...row, end_ms: NOW }, NOW, manual)).toBe(true);
  });
});
