// Levels of external events belong to the main calendar only: the primary
// calendar of the main account (events-external-priority.md rules 4, 5;
// planning-priorities.md PRI-42). An added account has a primary calendar
// too, and it is not the main calendar.
//
// Ways it can fail:
// 1. The planner offers the level control on the primary calendar of an
//    added account.
// 2. The API stores a level for an event on that calendar.
// 3. A level stored for that calendar (for example while its account was the
//    main one) lets booking links offer the time.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { calendarItems } from "../../src/server/api/booking.ts";
import { plannerEvents, plannerRoutes } from "../../src/server/api/planner.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { openDb, run } from "../../src/server/db.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  const account = (id: string, main: number) =>
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
       VALUES (?, ?, 'caldav', ?, ?, '', ?, ?)`,
      id,
      user.id,
      id,
      `${id}@example.com`,
      T0 + main,
      main,
    );
  account("main", 1);
  account("added", 0);
  for (const a of ["main", "added"]) {
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, writable, check_availability)
       VALUES (?, ?, ?, ?, 1, 1, 1)`,
      `cal-${a}`,
      a,
      `cal-${a}`,
      a,
    );
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy)
       VALUES (?, 'ev', ?, ?, ?, 1)`,
      `cal-${a}`,
      `Call ${a}`,
      T0 + HOUR,
      T0 + 2 * HOUR,
    );
    run(
      db,
      "INSERT INTO external_levels (user_id, calendar_id, target_id, level) VALUES (?, ?, 'ev', 4)",
      user.id,
      `cal-${a}`,
    );
  }
  return { db, user };
}

describe("levels of external events", () => {
  it("offers the level control only on the main calendar", () => {
    const { db, user } = setup();
    const evs = plannerEvents(db, user.id, T0, T0 + 24 * HOUR);
    expect(Object.fromEntries(evs.map((e) => [e.title, e.levelFixed ?? "editable"]))).toEqual({
      "Call main": "editable",
      "Call added": "other-calendar",
    });
  });

  it("lets booking links use a level only on the main calendar", () => {
    const { db, user } = setup();
    const items = calendarItems(db, user.id, T0, T0 + 24 * HOUR).filter((i) =>
      i.title?.startsWith("Call"),
    );
    expect(Object.fromEntries(items.map((i) => [i.title, i.cls]))).toEqual({
      "Call main": "prioritized",
      "Call added": "fixed",
    });
  });

  it("refuses a level for an event on the primary calendar of an added account", async () => {
    const { db, user } = setup();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", user);
      await next();
    });
    const sync = { request: () => {} } as unknown as SyncService;
    app.route(
      "/api/planner",
      plannerRoutes(db, sync, () => T0),
    );
    const post = (cal: string) =>
      app.request(`/api/planner/external/${cal}/ev/priority`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: 3 }),
      });
    expect((await post("cal-added")).status).toBe(400);
    expect((await post("cal-main")).status).toBe(200);
  });
});
