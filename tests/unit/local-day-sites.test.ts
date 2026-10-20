// Rules that count "N days" count local calendar days in the user's zone, not
// N x 24 hours. Each case below crosses a DST change, where 24-hour steps
// move the result by one hour, and near midnight by one day. Ways it can fail:
// 1. The default due date of a new task (TSK-1, dueInDays) is one hour off.
// 2. A task search "due within N days" (NXT-40) drops or adds a task at the edge.
// 3. The at-risk digest (meetings-flexible-rescheduling.md rule 35) takes the
//    wrong last date for "the next 14 days".
// 4. NTF-21 sends (or skips) a change email at the edge of meetingChangeDaysAhead.
// 5. The buffer preview list ends the scheduling window N x 7 x 24 h from now,
//    not at 24:00 local as the planner does (planning-scheduling-window.md).
// Rules outside the scheduler (1 to 4) count in the home zone, also during a
// trip; the scheduling window (5) uses the planning zone, as replan.ts.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { bufferFilterRoutes } from "../../src/server/api/buffer-filters.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { matchingTasks } from "../../src/server/api/task-searches.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { DailyMailWorker } from "../../src/server/daily-mail.ts";
import { type Db, one, openDb, run } from "../../src/server/db.ts";
import type { Mailer, Message } from "../../src/server/mail.ts";
import { updatePrefs } from "../../src/server/meeting-prefs.ts";
import { logChange } from "../../src/server/planner/meeting-log.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import { utcToLocal } from "../../src/shared/time.ts";

const at = (iso: string) => Date.parse(iso);
const wall = (zone: string, t: number) => {
  const l = utcToLocal(zone, t);
  const hh = String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0");
  const mm = String(l.minuteOfDay % 60).padStart(2, "0");
  return `${l.date} ${hh}:${mm}`;
};

function userIn(db: Db, zone: string, t: number): User {
  const u = ensureUser(db, "owner@example.com", "Owner", t);
  run(db, "UPDATE users SET time_zone = ?, first_sign_in_at = ? WHERE id = ?", zone, t, u.id);
  return { ...u, time_zone: zone };
}

function poster(user: User, routes: Hono<AppEnv>, path: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/api", routes);
  return (body: unknown) =>
    app.request(`/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

function itemsApp(db: Db, user: User, now: number) {
  const sync = { request: () => {} } as unknown as SyncService;
  return poster(
    user,
    itemRoutes(db, sync, () => now),
    "/tasks",
  );
}

describe("default due date of a new task (dueInDays 3)", () => {
  it.each([
    ["America/New_York", "2026-03-07T05:30:00Z", "2026-03-10 00:30"],
    ["America/New_York", "2026-10-30T04:30:00Z", "2026-11-02 00:30"],
    ["Europe/Lisbon", "2026-03-27T23:30:00Z", "2026-03-30 23:30"],
    ["Europe/Lisbon", "2026-10-23T23:30:00Z", "2026-10-27 00:30"],
  ])("in %s from %s is %s local", async (zone, now, expected) => {
    const db = openDb(":memory:");
    const user = userIn(db, zone, at(now));
    const res = await itemsApp(db, user, at(now))({ title: "Report" });
    expect(res.status, await res.clone().text()).toBe(201);
    const row = one<{ due_at: number }>(db, "SELECT due_at FROM tasks WHERE title = 'Report'");
    expect(wall(zone, row?.due_at ?? 0)).toBe(expected);
  });
});

describe("task search: due within N days", () => {
  it.each([
    // 3 local days after 2026-10-30 10:00 EDT is 2026-11-02 10:00 EST.
    ["America/New_York", "2026-10-30T14:00:00Z", "2026-11-02T14:30:00Z", "2026-11-02T15:30:00Z"],
    // 3 local days after 2026-03-27 10:00 WET is 2026-03-30 10:00 WEST.
    ["Europe/Lisbon", "2026-03-27T10:00:00Z", "2026-03-30T08:30:00Z", "2026-03-30T09:30:00Z"],
  ])(
    "in %s from %s includes the task due inside the 3rd local day and not after",
    async (zone, now, inside, outside) => {
      const db = openDb(":memory:");
      const user = userIn(db, zone, at(now));
      const post = itemsApp(db, user, at(now));
      for (const [title, due] of [
        ["Inside", inside],
        ["Outside", outside],
      ] as const) {
        const res = await post({ title, dueAt: at(due) });
        expect(res.status, await res.clone().text()).toBe(201);
      }
      const found = matchingTasks(
        db,
        user.id,
        { id: "s", name: "s", keyword: "", due_within_days: 3 },
        at(now),
        zone,
      );
      expect(found.map((t) => t.title)).toEqual(["Inside"]);
    },
  );
});

describe("at-risk digest: the next 14 days", () => {
  function setup(zone: string, dailyTime: string, periods: string[], t0: number) {
    const db = openDb(":memory:");
    const user = userIn(db, zone, t0);
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
       VALUES ('acc', ?, 'caldav', 'x', 'owner@example.com', '', ?, 1)`,
      user.id,
      t0,
    );
    updatePrefs(db, user.id, { dailyTime, atRiskDigest: true, newSeriesEmail: false });
    run(
      db,
      "INSERT INTO plan_reports (user_id, report, planned_at) VALUES (?, ?, ?)",
      user.id,
      JSON.stringify(
        periods.map((p, i) => ({
          itemKind: "meeting",
          itemId: `m${i}`,
          status: "unplaced",
          demandKey: `m${i}:${p}`,
        })),
      ),
      t0,
    );
    const sent: Message[] = [];
    const mailer: Mailer = { configured: true, send: async (m) => void sent.push(m) };
    const tick = (now: number) =>
      new DailyMailWorker({
        db,
        mailer,
        now: () => now,
        baseUrl: "http://localhost",
        intervalMs: 60_000,
        weeklyReports: false,
      }).tick();
    const atRisk = () => sent.filter((m) => m.subject.startsWith("Meetings at risk"));
    return { tick, atRisk };
  }

  it("includes the 14th local day when DST ends in between (New York, 00:30)", async () => {
    // 2026-10-26 00:30 EDT + 14 local days = 2026-11-09; 14 x 24 h ends on 2026-11-08 23:30 EST.
    const { tick, atRisk } = setup(
      "America/New_York",
      "00:30",
      ["2026-11-09"],
      at("2026-10-25T16:00:00Z"),
    );
    await tick(at("2026-10-25T16:00:00Z"));
    await tick(at("2026-10-26T04:30:00Z"));
    expect(atRisk()).toHaveLength(1);
  });

  it("names the 14th local day and not the 15th when DST starts in between (Lisbon, 23:30)", async () => {
    // 2026-03-15 23:30 WET + 14 local days = 2026-03-29; 14 x 24 h ends on 2026-03-30 00:30 WEST.
    const { tick, atRisk } = setup(
      "Europe/Lisbon",
      "23:30",
      ["2026-03-29", "2026-03-30"],
      at("2026-03-15T12:00:00Z"),
    );
    await tick(at("2026-03-15T12:00:00Z"));
    await tick(at("2026-03-15T23:30:00Z"));
    expect(atRisk()).toHaveLength(1);
    expect(atRisk()[0]?.subject).toBe("Meetings at risk: 1 in the next 14 days");
    expect(atRisk()[0]?.text).toContain("in the period from 2026-03-29");
    expect(atRisk()[0]?.text).not.toContain("2026-03-30");
  });
});

describe("NTF-21: change emails within meetingChangeDaysAhead days", () => {
  function setup(zone: string, now: number) {
    const db = openDb(":memory:");
    const user = userIn(db, zone, now);
    const hours = one<{ id: string }>(db, "SELECT id FROM hours_sets WHERE user_id = ?", user.id);
    run(
      db,
      `INSERT INTO meetings (id, user_id, title, level, frequency, ideal_minute, duration_minutes,
         shortest_minutes, hours_mode, hours_set_id, defense, when_unplaceable, created_at, rules_changed_at)
       VALUES ('m', ?, '1:1', 2, '{}', 600, 30, 30, 'everyone', ?, 'adaptive', 'remove', ?, ?)`,
      user.id,
      hours?.id ?? null,
      now,
      now,
    );
    /** The notify flag that logChange stores for a moved occurrence that starts at `start`. */
    const notify = (start: number) => {
      logChange(
        db,
        user.id,
        {
          meetingId: "m",
          key: `k${start}`,
          oldStart: null,
          oldEnd: null,
          newStart: start,
          newEnd: start + 1_800_000,
          actor: "tempoloom",
          reason: "conflict",
          written: true,
        },
        now,
      );
      return one<{ notify: number }>(
        db,
        "SELECT notify FROM meeting_changes WHERE occurrence_key = ?",
        `k${start}`,
      )?.notify;
    };
    return { db, user, notify };
  }

  it.each([
    // 7 local days after 2026-10-30 12:00 EDT is 2026-11-06 12:00 EST (17:00 UTC).
    ["America/New_York", "2026-10-30T16:00:00Z", "2026-11-06T16:30:00Z", "2026-11-06T17:30:00Z"],
    // 7 local days after 2026-03-25 12:00 WET is 2026-04-01 12:00 WEST (11:00 UTC).
    ["Europe/Lisbon", "2026-03-25T12:00:00Z", "2026-04-01T10:30:00Z", "2026-04-01T11:30:00Z"],
  ])(
    "in %s from %s: a start inside the 7th local day gets an email, one after it does not",
    (zone, now, inside, outside) => {
      const { notify } = setup(zone, at(now));
      expect(notify(at(inside))).toBe(1);
      expect(notify(at(outside))).toBe(0);
    },
  );

  it("counts the days in the home zone during a trip (New York home, Tokyo trip)", () => {
    // 7 local days after 2026-10-30 12:00 EDT is 2026-11-06 12:00 EST (17:00 UTC);
    // in Tokyo (no DST) 7 local days end one hour sooner, at 16:00 UTC.
    const now = at("2026-10-30T16:00:00Z");
    const { db, user, notify } = setup("America/New_York", now);
    run(
      db,
      `INSERT INTO travel_zones (id, user_id, tz, start_date, end_date, created_at)
       VALUES ('trip', ?, 'Asia/Tokyo', '2026-10-28', '2026-11-10', ?)`,
      user.id,
      now,
    );
    expect(notify(at("2026-11-06T16:30:00Z"))).toBe(1);
  });
});

describe("buffer preview: the scheduling window ends at 24:00 local", () => {
  it("lists an event on the last window day, and none on the day after (Berlin, 3 weeks)", async () => {
    // 2026-10-20 10:00 CEST + 21 local days = 2026-11-10; the window ends at
    // 2026-11-11 00:00 CET (2026-11-10T23:00Z). 21 x 24 h ends at 2026-11-10T08:00Z.
    const now = at("2026-10-20T08:00:00Z");
    const db = openDb(":memory:");
    const user = userIn(db, "Europe/Berlin", now);
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
       VALUES ('acc', ?, 'caldav', 'owner', 'owner@example.com', '', ?)`,
      user.id,
      now,
    );
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability)
       VALUES ('cal', 'acc', 'cal', 'Work', 1, 1)`,
    );
    for (const [id, start] of [
      ["last-day", "2026-11-10T14:00:00Z"],
      ["day-after", "2026-11-10T23:30:00Z"],
    ] as const)
      run(
        db,
        `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy)
         VALUES ('cal', ?, ?, ?, ?, 1)`,
        id,
        id,
        at(start),
        at(start) + 1_800_000,
      );
    const res = await poster(
      user,
      bufferFilterRoutes(db, () => now),
      "/buffers/matches",
    )({ filter: {} });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { events: { title: string }[] };
    expect(body.events.map((e) => e.title)).toEqual(["last-day"]);
  });
});
