// Google invitations after the organizerSelf fix (planning-scheduler.md
// SCH-21, focus-time.md rule 23).
//
// Ways it can fail:
// 1. Auto-decline answers the user's own meeting: the copy on a second
//    account or a secondary calendar has an organizer that is not `self` there.
// 2. Cached rows keep the old organizer_self until the next full read (about
//    30 days), so old unanswered invitations still block time.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { type Db, one, openDb, run } from "../../src/server/db.ts";
import type { GoogleCalendarApi, GoogleEvent } from "../../src/server/google/calendar.ts";
import { MIGRATIONS } from "../../src/server/migrations.ts";
import { afterPush } from "../../src/server/planner/after-push.ts";
import { fromGoogleEvent, GoogleProvider } from "../../src/server/providers/google.ts";
import type { CalendarProvider, ExternalChange } from "../../src/server/providers/types.ts";
import { cacheEvent, pullEvents } from "../../src/server/sync/pull.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;
const ME = "owner@example.com";
const WORK = "owner.work@example.com";
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();

const invite = (id: string, organizer: string, self: string, h = 26): GoogleEvent => ({
  id,
  status: "confirmed",
  summary: id,
  start: { dateTime: at(h) },
  end: { dateTime: at(h + 1) },
  organizer: { email: organizer },
  attendees: [
    { email: organizer, responseStatus: "accepted" },
    { email: self, self: true, responseStatus: "needsAction" },
  ],
});

function account(db: Db, userId: string, id: string, email: string) {
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES (?, ?, 'google', ?, ?, '', ?, ?)`,
    id,
    userId,
    `sub-${id}`,
    email,
    T0,
    id === "acc1" ? 1 : 0,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, sync_token)
     VALUES (?, ?, ?, ?, 1, 1, 'old-token')`,
    `cal-${id}`,
    id,
    email,
    email,
  );
}

describe("auto-decline on Google", () => {
  it("declines someone else's invitation but never the user's own meeting copy", async () => {
    const db = openDb(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    const user = ensureUser(db, ME, "Owner", T0);
    account(db, user.id, "acc1", ME);
    account(db, user.id, "acc2", WORK);
    run(
      db,
      `INSERT INTO focus_goals (id, user_id, title, hours_set_id, weekly_goal_minutes, daily_min_minutes,
         daily_max_minutes, min_block_minutes, max_block_minutes, created_at, rules_changed_at,
         decline_enabled, decline_message)
       VALUES ('goal', ?, 'Focus', 'h', 600, 60, 240, 60, 120, ?, ?, 1, 'Busy')`,
      user.id,
      T0,
      T0,
    );
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms,
         end_ms, busy, title) VALUES ('m', ?, 'cal-acc1', 'f1', 'k', 'focus', 'goal', ?, ?, 1, 'Focus')`,
      user.id,
      T0 + 24 * HOUR,
      T0 + 30 * HOUR,
    );
    // The user's meeting, made on the main account, invites the work account.
    cacheEvent(db, "cal-acc2", fromGoogleEvent(invite("own-copy", ME, WORK), "UTC"));
    // A secondary calendar of the user organizes a meeting with the main account.
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability)
       VALUES ('cal-side', 'acc1', 'side123@group.calendar.google.com', 'Side', 0, 0)`,
    );
    cacheEvent(
      db,
      "cal-acc1",
      fromGoogleEvent(invite("side-copy", "side123@group.calendar.google.com", ME, 27), "UTC"),
    );
    cacheEvent(db, "cal-acc1", fromGoogleEvent(invite("boss", "boss@example.com", ME, 28), "UTC"));
    const answered: string[] = [];
    const provider = {
      editExternal: async (_cal: string, eventId: string, change: ExternalChange) => {
        answered.push(`${eventId}:${change.selfResponse}`);
        return fromGoogleEvent(invite(eventId, "boss@example.com", ME, 28), "UTC");
      },
    } as unknown as CalendarProvider;
    await afterPush(db, user.id, () => provider, T0);
    expect(answered).toEqual(["boss:declined"]);
  });
});

describe("cached Google rows after the upgrade", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the first sync after the migration reads the calendar in full and updates organizerSelf", async () => {
    dir = mkdtempSync(join(tmpdir(), "tl-stale-"));
    const path = join(dir, "db.sqlite");
    // A database at the schema before this change's migration.
    const mine = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN organizer_email"));
    const BEFORE = mine === -1 ? MIGRATIONS.length : mine;
    const old = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, BEFORE)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${BEFORE}`);
    old.exec("PRAGMA foreign_keys = OFF");
    old.exec(
      `INSERT INTO users (id, email, name, created_at) VALUES ('u', '${ME}', 'Owner', ${T0})`,
    );
    old.exec(
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
       VALUES ('acc1', 'u', 'google', 'sub', '${ME}', '', ${T0}, 1)`,
    );
    old.exec(
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability,
         sync_token, window_start, window_end)
       VALUES ('cal', 'acc1', '${ME}', 'Main', 1, 1, 'old-token', ${T0 - 30 * 24 * HOUR}, ${T0 + 365 * 24 * HOUR})`,
    );
    // The old code stored organizer_self = 1 for this unanswered invitation.
    old.exec(
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy, self_response,
         attendee_count, organizer_self) VALUES ('cal', 'inv', 'inv', ${T0 + 26 * HOUR}, ${T0 + 27 * HOUR}, 1,
         'needsAction', 2, 1)`,
    );
    old.close();

    const db = openDb(path);
    const reads: string[] = [];
    const api = {
      listEvents: async (_id: string, opts: { syncToken?: string }) => {
        reads.push(opts.syncToken ? "incremental" : "full");
        // An incremental read finds nothing: the invitation did not change.
        return {
          events: opts.syncToken ? [] : [invite("inv", "boss@example.com", ME)],
          nextSyncToken: "new-token",
        };
      },
    } as unknown as GoogleCalendarApi;
    await pullEvents(db, new GoogleProvider(api, "UTC"), "cal", T0);
    expect(reads).toEqual(["full"]);
    expect(
      one<{ organizer_self: number }>(
        db,
        "SELECT organizer_self FROM events WHERE calendar_id = 'cal' AND event_id = 'inv'",
      )?.organizer_self,
    ).toBe(0);
    // The next sync is incremental again.
    await pullEvents(db, new GoogleProvider(api, "UTC"), "cal", T0);
    expect(reads).toEqual(["full", "incremental"]);
    db.close();
  });
});
