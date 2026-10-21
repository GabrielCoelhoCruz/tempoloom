// Repair one event from the lookup page (docs/specs/support-troubleshooting.md
// rule 10).
//
// Ways it can fail:
// 1. Repair is offered for a source event that a policy skipped: there is no
//    copy, so the repair writes nothing but the page says "Repaired".
// 2. Repair is offered for a copy of a paused mirroring (an account of it is
//    disconnected): the push leaves it as it is.
// 3. The run fails, and the repair still reports success.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { openDb, run } from "../../src/server/db.ts";
import { lookupEvent } from "../../src/server/diagnosis.ts";
import { SyncService } from "../../src/server/sync/service.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 6);
const T = Date.UTC(2026, 10, 3, 10);

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW - 30 * 86_400_000);
  run(db, "UPDATE users SET time_zone = 'UTC', first_sign_in_at = ? WHERE id = ?", NOW, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, server_url, credentials, created_at, is_main, calendars_synced_at)
     VALUES ('main', ?, 'caldav', 'a', 'owner@example.com', 'http://127.0.0.1:9/', '', 0, 1, ?),
            ('added', ?, 'caldav', 'b', 'extra@example.com', 'http://127.0.0.1:9/', '', 1, 0, ?)`,
    user.id,
    NOW,
    user.id,
    NOW,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('work', 'main', 'work', 'Work', 1, 1, 1), ('private', 'added', 'private', 'Private', 1, 1, 1)`,
  );
  // Private → Work. "Dentist" has a copy; "Lunch" is free, and this policy copies only busy time.
  run(
    db,
    `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type, visibility,
       all_day_mode, copy_outside_work_hours, enabled, created_at)
     VALUES ('p', ?, 'private', 'work', 'personal', 'busy_only', 'busy_only', 1, 1, 0)`,
    user.id,
  );
  const event = (cal: string, id: string, title: string, busy: number, props = "{}") =>
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy, private_props)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      cal,
      id,
      title,
      T,
      T + H,
      busy,
      props,
    );
  event("private", "dentist", "Dentist", 1);
  event("private", "lunch", "Lunch", 0);
  event("work", "copy-1", "Busy", 1, '{"tl":"1"}');
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
     VALUES ('m1', ?, 'work', 'copy-1', 'mirror:p:dentist', 'mirror', 'p', ?, ?, 1, 'Busy')`,
    user.id,
    T,
    T + H,
  );
  return { db, userId: user.id };
}

const repairOf = (db: ReturnType<typeof openDb>, userId: string, q: string) => {
  const r = lookupEvent(db, userId, q, NOW);
  if ("error" in r) throw new Error(r.error);
  return r.repair;
};

describe("repair one event (support rule 10)", () => {
  it("is offered for a copy and its source, not for a source that a policy skipped", () => {
    const { db, userId } = setup();
    expect(repairOf(db, userId, "copy-1")).toEqual(["mirror:p:dentist"]);
    expect(repairOf(db, userId, "dentist")).toEqual(["mirror:p:dentist"]);
    expect(repairOf(db, userId, "lunch")).toEqual([]);
  });

  it("is not offered while the mirroring is paused by a disconnected account", () => {
    const { db, userId } = setup();
    run(db, "UPDATE accounts SET status = 'reauth_required' WHERE id = 'added'");
    expect(repairOf(db, userId, "copy-1")).toEqual([]);
    expect(repairOf(db, userId, "dentist")).toEqual([]);
  });

  it("reports a failed run as failed", async () => {
    const { db, userId } = setup();
    const sync = new SyncService({
      db,
      box: new SecretBox(randomBytes(32).toString("base64")),
      oauth: undefined,
      serviceKey: undefined,
      now: () => NOW,
      intervalMs: 60_000,
      baseUrl: "http://localhost",
      log: () => {},
    });
    // The CalDAV server at port 9 does not answer: the run fails.
    expect(await sync.repair(userId, ["mirror:p:dentist"])).toBe(false);
  });
});
