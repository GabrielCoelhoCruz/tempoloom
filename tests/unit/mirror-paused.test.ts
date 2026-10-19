// A mirroring policy pauses while the account of its source or destination
// calendar is disconnected (accounts-login-emails-permissions.md rule 16;
// sync-calendar-mirroring.md): its copies stay as they are.
//
// Ways it can fail:
// 1. The policy still makes copies from the source events that were read
//    before the disconnect, so a stale time is written to the destination.
// 2. The copies of the paused policy are deleted because no copy is wanted.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import { mirrorCopies } from "../../src/server/planner/mirror.ts";
import { pushSchedule } from "../../src/server/planner/push.ts";
import type { CalendarProvider } from "../../src/server/providers/types.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;

function setup(lost: "source" | "destination") {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  for (const [id, status] of [
    ["src-acc", lost === "source" ? "reauth_required" : "ok"],
    ["dst-acc", lost === "destination" ? "reauth_required" : "ok"],
  ] as const)
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
       VALUES (?, ?, 'caldav', ?, 'owner@example.com', '', ?, ?, 0)`,
      id,
      user.id,
      id,
      status,
      T0,
    );
  for (const [id, acc] of [
    ["src", "src-acc"],
    ["dst", "dst-acc"],
  ] as const)
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
       VALUES (?, ?, ?, ?, 0, 1, 1)`,
      id,
      acc,
      id,
      id,
    );
  run(
    db,
    `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type,
       visibility, all_day_mode, created_at) VALUES ('p', ?, 'src', 'dst', 'personal', 'busy_only', 'none', ?)`,
    user.id,
    T0,
  );
  // The source event as read before the disconnect, one hour later than its copy.
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy)
     VALUES ('src', 'e1', 'Dentist', ?, ?, 1)`,
    T0 + 25 * HOUR,
    T0 + 26 * HOUR,
  );
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
       start_ms, end_ms, busy, title) VALUES ('m1', ?, 'dst', 'copy-1', 'mirror:p:e1', 'mirror', 'p', ?, ?, 1, 'Busy')`,
    user.id,
    T0 + 24 * HOUR,
    T0 + 25 * HOUR,
  );
  const calls: string[] = [];
  const provider = new Proxy({} as CalendarProvider, {
    get: (_t, name) => async () => {
      calls.push(String(name));
      throw new Error(`unexpected ${String(name)}`);
    },
  });
  return { db, user, calls, provider };
}

describe("a paused mirroring policy", () => {
  it.each(["source", "destination"] as const)(
    "makes no copies and keeps its copies while the %s account is disconnected",
    async (lost) => {
      const { db, user, calls, provider } = setup(lost);
      const copies = mirrorCopies(db, user.id, "UTC", T0, null);
      expect(copies).toEqual([]);
      await pushSchedule(
        {
          db,
          userId: user.id,
          now: T0,
          target: (id) => ({ provider, providerCalendarId: id }),
        },
        copies,
      );
      expect(calls).toEqual([]);
      expect(all(db, "SELECT key, start_ms FROM managed_events")).toEqual([
        { key: "mirror:p:e1", start_ms: T0 + 24 * HOUR },
      ]);
    },
  );
});
