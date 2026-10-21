// Event tips (docs/specs/planning-event-content.md CNT-15) and the planner's
// "view as" privacy (planning-planner.md PLN-6) after an upgrade.
//
// Ways it can fail:
// 1. A tip change alone (tips turned on or off) writes over the organizer's
//    own description of a meeting occurrence (meetings-flexible-rescheduling.md
//    rule 22).
// 2. A tip change alone on a meeting goes to a CalDAV server that mails the
//    guests on each change (RFC 6638 calendar-auto-schedule).
// 3. The upgrade turns tips on for existing users, so the first plan run
//    rewrites every future managed event.
// 4. Events read before the upgrade keep no privacy, so "view as others"
//    shows their titles until the next full read.
// 5. The now line has no privacy, so "view as others" shows its title.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, type Db, openDb, run } from "../../src/server/db.ts";
import { MIGRATIONS } from "../../src/server/migrations.ts";
import { nextMeeting } from "../../src/server/planner/now.ts";
import { type DesiredEvent, pushSchedule } from "../../src/server/planner/push.ts";
import { CalDavProvider } from "../../src/server/providers/caldav.ts";
import type { CalendarProvider, ProviderEvent } from "../../src/server/providers/types.ts";
import { getSettings } from "../../src/server/settings.ts";
import { cacheEvent } from "../../src/server/sync/pull.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;
const START = T0 + 26 * HOUR;
const TIP = "Tempoloom tip: to reschedule, decline this event.";
const FOOTER = "Scheduled by Tempoloom";
const EXTRA = {
  location: "",
  attendees: ["dana@example.com"],
  optional: [],
  organizer: "owner@example.com",
};

function setup(written: string) {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'acc', 'owner@example.com', '', 'ok', ?, 1)`,
    user.id,
    T0,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1)`,
  );
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
       start_ms, end_ms, busy, title, description, extra)
     VALUES ('m1', ?, 'cal', 'occ-1', 'meeting:r:1', 'meeting', 'r', ?, ?, 1, 'Review', ?, ?)`,
    user.id,
    START,
    START + HOUR / 2,
    written,
    JSON.stringify(EXTRA),
  );
  return { db, userId: user.id };
}

const copy = (description: string): ProviderEvent => ({
  id: "occ-1",
  cancelled: false,
  etag: '"1"',
  summary: "Review",
  description,
  location: "",
  start: START,
  end: START + HOUR / 2,
  allDay: false,
  busy: true,
  eventType: "default",
  selfResponse: null,
  attendeeCount: 1,
  attendees: ["dana@example.com"],
  organizerSelf: true,
  recurringId: null,
  colorId: null,
  updated: null,
  privateProps: { tl: "1" },
  visibility: "default",
});

const desired = (description: string): DesiredEvent => ({
  key: "meeting:r:1",
  kind: "meeting",
  sourceId: "r",
  calendarId: "cal",
  start: START,
  end: START + HOUR / 2,
  title: "Review",
  description,
  busy: true,
  colorId: null,
  attendees: ["dana@example.com"],
  optionalAttendees: [],
  organizer: "owner@example.com",
});

/** Pushes `d` with the calendar copy `inCalendar`; returns the edits sent. */
async function push(
  s: ReturnType<typeof setup>,
  inCalendar: string,
  d: DesiredEvent,
  notifiesGuests: boolean,
): Promise<unknown[]> {
  cacheEvent(s.db, "cal", copy(inCalendar));
  const edits: unknown[] = [];
  const provider = {
    notifiesGuests: async () => notifiesGuests,
    editExternal: async (_c: string, _id: string, change: unknown) => {
      edits.push(change);
      return copy(inCalendar);
    },
  } as unknown as CalendarProvider;
  await pushSchedule(
    {
      db: s.db as Db,
      userId: s.userId,
      now: T0,
      target: () => ({ provider, providerCalendarId: "cal" }),
    },
    [d],
  );
  return edits;
}

const plain = `Agenda\n\n${FOOTER}`;
const tipped = `Agenda\n\n${TIP}\n\n${FOOTER}`;

describe("a tip change alone on a meeting occurrence (CNT-15, rule 22)", () => {
  it("keeps the organizer's own description when tips go off", async () => {
    const s = setup(tipped);
    expect(await push(s, "Bring the Q3 numbers", desired(plain), false)).toEqual([]);
  });

  it("keeps the organizer's own description when tips come on", async () => {
    const s = setup(plain);
    expect(await push(s, "Bring the Q3 numbers", desired(tipped), false)).toEqual([]);
  });

  it("is written where the calendar still has Tempoloom's text and mails no guest", async () => {
    const s = setup(tipped);
    expect(await push(s, tipped, desired(plain), false)).toEqual([{ description: plain }]);
  });

  it("is not written where the server mails the guests on each change", async () => {
    const s = setup(tipped);
    expect(await push(s, tipped, desired(plain), true)).toEqual([]);
  });

  it("does not stop a form description edit (rule 23)", async () => {
    const s = setup(tipped);
    const v2 = `Agenda v2\n\n${FOOTER}`;
    expect(await push(s, "Bring the Q3 numbers", desired(v2), true)).toEqual([{ description: v2 }]);
  });
});

/** A database at the schema before the upgrade (every migration but the last), then upgraded. */
function upgrade(before: (db: DatabaseSync) => void): Db {
  const dir = mkdtempSync(join(tmpdir(), "tl-tips-"));
  const path = join(dir, "db.sqlite");
  const old = new DatabaseSync(path);
  for (const [i, sql] of MIGRATIONS.slice(0, -1).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${i + 1}`);
  }
  before(old);
  old.close();
  const db = openDb(path);
  rmSync(dir, { recursive: true, force: true });
  return db;
}

describe("the upgrade", () => {
  it("keeps tips off for existing users and on for new ones (CNT-15)", () => {
    const db = upgrade((old) => {
      old.exec(
        `INSERT INTO users (id, email, name, settings, created_at) VALUES
           ('old', 'old@example.com', 'Old', '{}', 0),
           ('on', 'on@example.com', 'On', '{"eventTips":true}', 0)`,
      );
    });
    expect(getSettings(db, "old").eventTips).toBe(false);
    expect(getSettings(db, "on").eventTips).toBe(true);
    const fresh = ensureUser(db, "new@example.com", "New", T0);
    expect(getSettings(db, fresh.id).eventTips).toBe(true);
  });

  it("reads every calendar in full once, so each event gets its privacy (PLN-6)", () => {
    const db = upgrade((old) => {
      old.exec(
        `INSERT INTO users (id, email, name, settings, created_at) VALUES ('u', 'u@example.com', 'U', '{}', 0);
         INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
           VALUES ('acc', 'u', 'caldav', 'acc', 'u@example.com', '', 'ok', 0, 1);
         INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable, sync_token)
           VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1, 'token-1');`,
      );
    });
    expect(all<{ sync_token: string | null }>(db, "SELECT sync_token FROM calendars")).toEqual([
      { sync_token: null },
    ]);
  });
});

describe("the privacy of each cached event", () => {
  it("is stored for every event, and alerts only for Tempoloom's own (PLN-6)", () => {
    const s = setup(plain);
    cacheEvent(s.db, "cal", {
      ...copy("x"),
      id: "ext-1",
      privateProps: {},
      visibility: "private",
      alerts: true,
    });
    cacheEvent(s.db, "cal", { ...copy("x"), id: "own-1", alerts: true });
    expect(
      all(s.db, "SELECT event_id, alerts, own_visibility FROM events ORDER BY event_id"),
    ).toEqual([
      { event_id: "ext-1", alerts: 0, own_visibility: "private" },
      { event_id: "own-1", alerts: 1, own_visibility: "default" },
    ]);
  });
});

describe("the now line (PLN-6, PLN-7)", () => {
  it("says whether the meeting is private and busy", () => {
    const s = setup(plain);
    cacheEvent(s.db, "cal", {
      ...copy("x"),
      id: "ext-1",
      summary: "Doctor",
      privateProps: {},
      visibility: "private",
    });
    expect(nextMeeting(s.db, s.userId, T0)).toMatchObject({
      title: "Doctor",
      private: true,
      busy: true,
    });
  });
});

describe("the CalDAV server's scheduling (RFC 6638)", () => {
  async function server(dav: string, statuses: number[] = []) {
    const srv = createServer((req, res) => {
      res.statusCode = statuses.shift() ?? 200;
      res.setHeader("DAV", dav);
      res.end(req.method);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/cal/`;
    const p = new CalDavProvider(
      { serverUrl: url, username: "u", password: "p", email: "u@example.com" },
      "UTC",
    );
    return { notifies: () => p.notifiesGuests(url), close: () => srv.close() };
  }

  it("mails guests when the server has calendar-auto-schedule", async () => {
    const s = await server("1, 2, 3, calendar-access, calendar-auto-schedule");
    expect(await s.notifies()).toBe(true);
    s.close();
  });

  it("counts an error answer (405, 500) as mailing guests, and asks again later", async () => {
    const s = await server("1, 2, 3, calendar-access", [405, 500]);
    expect(await s.notifies()).toBe(true);
    expect(await s.notifies()).toBe(true);
    // Only a definite answer is kept: the next 200 without scheduling counts.
    expect(await s.notifies()).toBe(false);
    s.close();
  });

  it("mails no guest when the server has no scheduling (Radicale)", async () => {
    const s = await server("1, 2, 3, calendar-access, addressbook");
    expect(await s.notifies()).toBe(false);
    s.close();
  });
});
