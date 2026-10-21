// The auto-lock run (docs/specs/planning-locks.md LCK-30 to LCK-33).
//
// Ways it can fail:
// 1. The run locks before 01:00 or after 02:00, or runs again later the same
//    day and locks events placed after it (LCK-31, LCK-32).
// 2. "week" counts the week from Monday when the user's week starts on Sunday,
//    or runs on another day than the first day of the week (LCK-30, LCK-33).
// 3. A kind turned on waits for the next day instead of locking at once (LCK-32).
// 4. The first run after a deploy (no record yet) locks at any hour.
// 5. On a trip the run uses the home zone, so it locks the wrong day at the
//    wrong hour (timezones-home-and-travel.md rule 13).
// 6. A change other than off to on (day to week, a new week start) locks
//    more days at once.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { settingsRoutes } from "../../src/server/api/settings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, type Db, openDb, run } from "../../src/server/db.ts";
import { autoLock } from "../../src/server/planner/auto-lock.ts";
import { type Settings, settingsSchema, updateSettings } from "../../src/server/settings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const at = (date: string, hhmm: string, zone = ZONE) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(zone, date, h * 60 + m);
};
// Sunday 2026-11-01 to Saturday 2026-11-07.
const SUN = "2026-11-01";
const SAT_BEFORE = "2026-10-31";

function setup(): {
  db: Db;
  userId: string;
  add: (key: string, kind: string, date: string, zone?: string) => void;
} {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", at(SUN, "00:00") - 86_400_000);
  run(db, "UPDATE users SET time_zone = ? WHERE id = ?", ZONE, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'x', 'owner@example.com', '', 0, 1)`,
    user.id,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1)`,
  );
  const add = (key: string, kind: string, date: string, zone = ZONE) =>
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
       VALUES (?, ?, 'cal', ?, ?, ?, 'src', ?, ?, 0, ?)`,
      key,
      user.id,
      key,
      key,
      kind,
      at(date, "12:00", zone),
      at(date, "12:30", zone),
      key,
    );
  return { db, userId: user.id, add };
}

const lock = (
  db: Db,
  userId: string,
  settings: Pick<Settings, "autoLock" | "weekStart">,
  now: number,
  force: Parameters<typeof autoLock>[4] = [],
) => autoLock(db, userId, settings, now, force);

const lockedKeys = (db: Db) =>
  all<{ key: string }>(db, "SELECT key FROM managed_events WHERE locked = 1 ORDER BY key").map(
    (r) => r.key,
  );

describe("autoLock", () => {
  it("runs once a day in the hour from 01:00 and leaves later events unlocked", () => {
    const { db, userId, add } = setup();
    add("t-sun", "task", SUN);
    add("t-mon", "task", "2026-11-02");
    add("t-tue", "task", "2026-11-03");
    add("h-sun", "habit", SUN);
    const settings = settingsSchema.parse({ autoLock: { task: "day", meeting: "off" } });
    lock(db, userId, settings, at(SAT_BEFORE, "15:00"));
    lock(db, userId, settings, at(SUN, "00:30"));
    expect(lockedKeys(db)).toEqual([]);
    lock(db, userId, settings, at(SUN, "01:05"));
    expect(lockedKeys(db)).toEqual(["t-sun"]);
    add("t-sun-late", "task", SUN);
    lock(db, userId, settings, at(SUN, "03:00"));
    expect(lockedKeys(db)).toEqual(["t-sun"]);
    // Turned off and on: runs at once.
    lock(db, userId, settings, at(SUN, "03:00"), ["task"]);
    expect(lockedKeys(db)).toEqual(["t-sun", "t-sun-late"]);
    // The next day runs again.
    lock(db, userId, settings, at("2026-11-02", "01:30"));
    expect(lockedKeys(db)).toEqual(["t-mon", "t-sun", "t-sun-late"]);
    // A day whose hour from 01:00 has passed (the server was down) does not lock.
    lock(db, userId, settings, at("2026-11-03", "02:05"));
    expect(lockedKeys(db)).toEqual(["t-mon", "t-sun", "t-sun-late"]);
  });

  it("counts the week from the user's first day of the week, and runs only on that day", () => {
    const { db, userId, add } = setup();
    add("h-sat-before", "habit", SAT_BEFORE);
    add("h-sun", "habit", SUN);
    add("h-sat", "habit", "2026-11-07");
    add("h-next-sun", "habit", "2026-11-08");
    const settings = settingsSchema.parse({ weekStart: 7, autoLock: { habit: "week" } });
    lock(db, userId, settings, at(SAT_BEFORE, "15:00"));
    lock(db, userId, settings, at(SUN, "01:30"));
    expect(lockedKeys(db)).toEqual(["h-sat", "h-sun"]);
  });

  it("locks flexible meetings of the day by default, and nothing else", () => {
    const { db, userId, add } = setup();
    add("m-sun", "meeting", SUN);
    add("f-sun", "focus", SUN);
    lock(db, userId, settingsSchema.parse({}), at(SAT_BEFORE, "15:00"));
    lock(db, userId, settingsSchema.parse({}), at(SUN, "01:30"));
    expect(lockedKeys(db)).toEqual(["m-sun"]);
  });

  it("the first run without a record locks nothing, at any hour; the next 01:00 locks", () => {
    const { db, userId, add } = setup();
    add("m-sun", "meeting", SUN);
    add("m-mon", "meeting", "2026-11-02");
    const settings = settingsSchema.parse({});
    lock(db, userId, settings, at(SUN, "01:30"));
    lock(db, userId, settings, at(SUN, "11:00"));
    expect(lockedKeys(db)).toEqual([]);
    lock(db, userId, settings, at("2026-11-02", "01:10"));
    expect(lockedKeys(db)).toEqual(["m-mon"]);
  });

  it("uses the zone of the trip on its dates (planning zone)", () => {
    const { db, userId, add } = setup();
    const NY = "America/New_York";
    run(
      db,
      `INSERT INTO travel_zones (id, user_id, tz, start_date, end_date, created_at)
       VALUES ('trip', ?, ?, '2026-11-01', '2026-11-08', 0)`,
      userId,
      NY,
    );
    add("t-mon-ny", "task", "2026-11-02", NY);
    add("t-tue-ny", "task", "2026-11-03", NY);
    const settings = settingsSchema.parse({ autoLock: { task: "day", meeting: "off" } });
    lock(db, userId, settings, at(SUN, "15:00", NY));
    // 01:30 in Berlin is Sunday evening in New York: no run.
    lock(db, userId, settings, at("2026-11-02", "01:30"));
    expect(lockedKeys(db)).toEqual([]);
    // 01:30 in New York locks the New York Monday, not Tuesday.
    lock(db, userId, settings, at("2026-11-02", "01:30", NY));
    expect(lockedKeys(db)).toEqual(["t-mon-ny"]);
  });

  it("a week start change locks no other days before the first day of the new week", () => {
    const { db, userId, add } = setup();
    add("h-fri", "habit", "2026-11-06");
    add("h-sun-next", "habit", "2026-11-08");
    add("h-mon-next", "habit", "2026-11-09");
    // The week starts on Sunday: Sunday 2026-11-01 01:30 locks 11-01 to 11-07.
    const sunday = settingsSchema.parse({ weekStart: 7, autoLock: { habit: "week" } });
    lock(db, userId, sunday, at(SAT_BEFORE, "15:00"));
    lock(db, userId, sunday, at(SUN, "01:30"));
    expect(lockedKeys(db)).toEqual(["h-fri"]);
    // The week now starts on Monday (11-02 to 11-08). Thursday 01:30: no run, so 11-08 stays open.
    const monday = settingsSchema.parse({ weekStart: 1, autoLock: { habit: "week" } });
    lock(db, userId, monday, at("2026-11-05", "01:30"));
    expect(lockedKeys(db)).toEqual(["h-fri"]);
    // Monday 2026-11-09 01:30: the new week runs.
    lock(db, userId, monday, at("2026-11-09", "01:30"));
    expect(lockedKeys(db)).toEqual(["h-fri", "h-mon-next"]);
  });
});

describe("PATCH /api/settings auto-lock", () => {
  it("locks at once only when a kind goes from off to on, not from day to week", async () => {
    const { db, userId, add } = setup();
    const NOW = at("2026-11-04", "15:00");
    add("h-thu", "habit", "2026-11-05");
    add("t-thu", "task", "2026-11-05");
    updateSettings(db, userId, { autoLock: { habit: "day", task: "off" } });
    run(
      db,
      "INSERT INTO auto_lock_runs (user_id, kind, period) VALUES (?, 'habit', 'day:2026-11-04')",
      userId,
    );
    const user = { id: userId, email: "owner@example.com", name: "Owner", time_zone: ZONE };
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", user as never);
      await next();
    });
    app.route(
      "/api",
      settingsRoutes(db, { request: () => {} } as unknown as SyncService, () => NOW),
    );
    const patch = (autoLock: object) =>
      app.request("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoLock }),
      });
    expect((await patch({ habit: "week" })).status).toBe(200);
    expect(lockedKeys(db)).toEqual([]);
    expect((await patch({ task: "week" })).status).toBe(200);
    expect(lockedKeys(db)).toEqual(["t-thu"]);
  });
});
