// Rules that count "N days" count local calendar days in the user's zone, not
// N x 24 hours. Each case below crosses a DST change, where 24-hour steps
// move the result by one hour, and near midnight by one day. Ways it can fail:
// 1. The default due date of a new task (TSK-1, dueInDays) is one hour off.
// 2. A task search "due within N days" (NXT-40) drops or adds a task at the edge.
// 3. The at-risk digest (meetings-flexible-rescheduling.md rule 35) takes the
//    wrong last date for "the next 14 days".
// 4. NTF-21 sends (or skips) a change email at the edge of meetingChangeDaysAhead.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { matchingTasks } from "../../src/server/api/task-searches.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { DailyMailWorker } from "../../src/server/daily-mail.ts";
import { type Db, one, openDb, run } from "../../src/server/db.ts";
import type { Mailer, Message } from "../../src/server/mail.ts";
import { updatePrefs } from "../../src/server/meeting-prefs.ts";
import { notifyFor } from "../../src/server/planner/meeting-log.ts";
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

function itemsApp(db: Db, user: User, now: number) {
  const sync = { request: () => {} } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    itemRoutes(db, sync, () => now),
  );
  return (body: unknown) =>
    app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
  function setup(zone: string, dailyTime: string, period: string, t0: number) {
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
      JSON.stringify([
        { itemKind: "meeting", itemId: "m1", status: "unplaced", demandKey: `m1:${period}` },
      ]),
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
      "2026-11-09",
      at("2026-10-25T16:00:00Z"),
    );
    await tick(at("2026-10-25T16:00:00Z"));
    await tick(at("2026-10-26T04:30:00Z"));
    expect(atRisk()).toHaveLength(1);
  });

  it("excludes the 15th local day when DST starts in between (Lisbon, 23:30)", async () => {
    // 2026-03-15 23:30 WET + 14 local days = 2026-03-29; 14 x 24 h ends on 2026-03-30 00:30 WEST.
    const { tick, atRisk } = setup(
      "Europe/Lisbon",
      "23:30",
      "2026-03-30",
      at("2026-03-15T12:00:00Z"),
    );
    await tick(at("2026-03-15T12:00:00Z"));
    await tick(at("2026-03-15T23:30:00Z"));
    expect(atRisk()).toHaveLength(0);
  });
});

describe("NTF-21: change emails within meetingChangeDaysAhead days", () => {
  const change = (start: number) => ({
    meetingId: "m",
    key: "k",
    oldStart: null,
    oldEnd: null,
    newStart: start,
    newEnd: start + 1_800_000,
    actor: "tempoloom",
    reason: "conflict" as const,
    written: true,
  });
  it.each([
    // 7 local days after 2026-10-30 12:00 EDT is 2026-11-06 12:00 EST (17:00 UTC).
    ["America/New_York", "2026-10-30T16:00:00Z", "2026-11-06T16:30:00Z", "2026-11-06T17:30:00Z"],
    // 7 local days after 2026-03-25 12:00 WET is 2026-04-01 12:00 WEST (11:00 UTC).
    ["Europe/Lisbon", "2026-03-25T12:00:00Z", "2026-04-01T10:30:00Z", "2026-04-01T11:30:00Z"],
  ])(
    "in %s from %s: a start inside the 7th local day gets an email, one after it does not",
    (zone, now, inside, outside) => {
      const db = openDb(":memory:");
      const user = userIn(db, zone, at(now));
      expect(notifyFor(db, user.id, change(at(inside)), at(now))).toBe(1);
      expect(notifyFor(db, user.id, change(at(outside)), at(now))).toBe(0);
    },
  );
});
