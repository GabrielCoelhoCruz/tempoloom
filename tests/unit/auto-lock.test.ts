// The auto-lock run (docs/specs/planning-locks.md LCK-30 to LCK-33).
//
// Ways it can fail:
// 1. The run locks before 01:00, or runs again later the same day and locks
//    events placed after it (LCK-31, LCK-32).
// 2. "week" counts the week from Monday when the user's week starts on Sunday (LCK-33).
// 3. A changed setting waits for the next day instead of locking at once (LCK-32).
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, type Db, openDb, run } from "../../src/server/db.ts";
import { autoLock } from "../../src/server/planner/auto-lock.ts";
import { settingsSchema } from "../../src/server/settings.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
// Sunday 2026-11-01 to Saturday 2026-11-07.
const SUN = "2026-11-01";

function setup(): {
  db: Db;
  userId: string;
  add: (key: string, kind: string, date: string) => void;
} {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", at(SUN, "00:00") - 86_400_000);
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
  const add = (key: string, kind: string, date: string) =>
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
       VALUES (?, ?, 'cal', ?, ?, ?, 'src', ?, ?, 0, ?)`,
      key,
      user.id,
      key,
      key,
      kind,
      at(date, "12:00"),
      at(date, "12:30"),
      key,
    );
  return { db, userId: user.id, add };
}

const lockedKeys = (db: Db) =>
  all<{ key: string }>(db, "SELECT key FROM managed_events WHERE locked = 1 ORDER BY key").map(
    (r) => r.key,
  );

describe("autoLock", () => {
  it("runs once a day from 01:00 and leaves later events unlocked", () => {
    const { db, userId, add } = setup();
    add("t-sun", "task", SUN);
    add("t-mon", "task", "2026-11-02");
    add("h-sun", "habit", SUN);
    const settings = settingsSchema.parse({ autoLock: { task: "day", meeting: "off" } });
    autoLock(db, userId, ZONE, settings, at(SUN, "00:30"));
    expect(lockedKeys(db)).toEqual([]);
    autoLock(db, userId, ZONE, settings, at(SUN, "01:05"));
    expect(lockedKeys(db)).toEqual(["t-sun"]);
    add("t-sun-late", "task", SUN);
    autoLock(db, userId, ZONE, settings, at(SUN, "03:00"));
    expect(lockedKeys(db)).toEqual(["t-sun"]);
    // A changed setting runs at once.
    autoLock(db, userId, ZONE, settings, at(SUN, "03:00"), ["task"]);
    expect(lockedKeys(db)).toEqual(["t-sun", "t-sun-late"]);
    // The next day runs again.
    autoLock(db, userId, ZONE, settings, at("2026-11-02", "01:30"));
    expect(lockedKeys(db)).toEqual(["t-mon", "t-sun", "t-sun-late"]);
  });

  it("counts the week from the user's first day of the week", () => {
    const { db, userId, add } = setup();
    add("h-sat-before", "habit", "2026-10-31");
    add("h-sun", "habit", SUN);
    add("h-sat", "habit", "2026-11-07");
    add("h-next-sun", "habit", "2026-11-08");
    const settings = settingsSchema.parse({ weekStart: 7, autoLock: { habit: "week" } });
    autoLock(db, userId, ZONE, settings, at(SUN, "01:30"));
    expect(lockedKeys(db)).toEqual(["h-sat", "h-sun"]);
  });

  it("locks flexible meetings of the day by default, and nothing else", () => {
    const { db, userId, add } = setup();
    add("m-sun", "meeting", SUN);
    add("f-sun", "focus", SUN);
    autoLock(db, userId, ZONE, settingsSchema.parse({}), at(SUN, "01:30"));
    expect(lockedKeys(db)).toEqual(["m-sun"]);
  });
});
