// Flexible meeting rules through the API and the planner snapshot
// (docs/specs/meetings-flexible.md). The E2E suite proves the calendar writes;
// these cases need a clock the browser cannot move, or read a value the UI
// does not show.
//
// Ways it can fail:
// 1. A title-only edit marks the rules changed, so every future occurrence is
//    placed again outside the move limit (MEET-02 rule 4).
// 2. The preview while editing adds a second meeting next to the saved one,
//    or counts its periods from "now" instead of the creation day.
// 3. A change of an attendee's meeting hours or time zone does not place the
//    meeting again; a change of a set the attendee's meetings do not use does.
// 4. An edit of a meeting that manages a series changes its frequency or moves
//    its start date: its periods stop matching the series' instances and the
//    push deletes them (rules 1, 10).
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { plan } from "../../src/scheduler/plan.ts";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { meetingItems } from "../../src/server/planner/meetings.ts";
import { loadSnapshot } from "../../src/server/planner/replan.ts";
import { getSettings } from "../../src/server/settings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-19T08:00:00Z"); // a Monday

function setup() {
  const db = openDb(":memory:");
  const owner = ensureUser(db, "owner@example.com", "Owner", T0);
  const clock = { t: T0 };
  const sync = { request() {}, exclusive: async () => undefined } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", owner);
    await next();
  });
  app.route(
    "/api",
    meetingRoutes(db, sync, () => clock.t),
  );
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const status = async (method: string, path: string, body: unknown) =>
    (
      await app.request(`/api${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status;
  return { db, owner, clock, call, status };
}

const sync1 = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  attendees: [{ email: "dana@example.com" }],
  frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
  idealTime: "10:00",
  durationMinutes: 30,
  ...over,
});

const changedAt = (db: Db, id: string) =>
  one<{ t: number }>(db, "SELECT rules_changed_at AS t FROM meetings WHERE id = ?", id)?.t;

describe("meeting edits", () => {
  it("keeps the rules unchanged on a title-only edit, and marks them changed on a time edit", async () => {
    const { db, clock, call } = setup();
    const { id } = (await call("POST", "/meetings", sync1("Sync"))) as { id: string };
    expect(changedAt(db, id)).toBe(T0);
    clock.t = T0 + DAY;
    await call("PUT", `/meetings/${id}`, sync1("Weekly sync", { description: "Notes" }));
    expect(changedAt(db, id)).toBe(T0);
    clock.t = T0 + 2 * DAY;
    await call("PUT", `/meetings/${id}`, sync1("Weekly sync", { idealTime: "11:00" }));
    expect(changedAt(db, id)).toBe(T0 + 2 * DAY);
  });

  it("previews an edit in place of the saved meeting, with its creation day", async () => {
    const { clock, call } = setup();
    const { id } = (await call("POST", "/meetings", sync1("Sync"))) as { id: string };
    const iso = (r: Record<string, unknown>) =>
      (r.occurrences as { start: number }[]).map((o) => new Date(o.start).toISOString());
    // The saved meeting holds Tuesday 10:00; the preview of the same rules shows that time.
    const same = await call("POST", `/meetings/preview?id=${id}`, sync1("Sync"));
    expect(iso(same)[0]).toBe("2026-10-20T10:00:00.000Z");
    expect(same.moved).toBe(0);

    const fortnight = sync1("Fortnight", {
      frequency: { period: "weekly", everyWeeks: 2, idealDays: [2] },
    });
    const made = (await call("POST", "/meetings", fortnight)) as { id: string };
    // A week later, the off week stays off: periods count from the creation day.
    clock.t = T0 + 7 * DAY;
    const later = await call("POST", `/meetings/preview?id=${made.id}`, fortnight);
    expect(iso(later)[0]?.slice(0, 10)).toBe("2026-11-03");
  });
});

describe("series edits", () => {
  /**
   * A meeting that manages a series, as POST with `series` leaves it, with one
   * managed instance in each period the planner gives it now.
   */
  async function seriesMeeting(frequency: Record<string, unknown>) {
    const s = setup();
    const { id } = (await s.call("POST", "/meetings", sync1("Standup", { frequency }))) as {
      id: string;
    };
    run(
      s.db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
       VALUES ('acc', ?, 'caldav', 'owner', 'owner@example.com', '', ?)`,
      s.owner.id,
      T0,
    );
    run(
      s.db,
      "INSERT INTO calendars (id, account_id, provider_id, name, is_primary) VALUES ('cal', 'acc', 'cal', 'Work', 1)",
    );
    for (const p of placed(s.db, s.owner.id, id))
      run(
        s.db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
         VALUES (?, ?, 'cal', ?, ?, 'meeting', ?, ?, ?, 1, 'Standup')`,
        p.key,
        s.owner.id,
        `ser#${p.key}`,
        p.key,
        id,
        p.start,
        p.end,
      );
    run(
      s.db,
      "UPDATE meetings SET series_calendar_id = 'cal', series_event_id = 'ser', starting = '2026-10-19' WHERE id = ?",
      id,
    );
    const saved = () =>
      one<{ f: string; s: string | null }>(
        s.db,
        "SELECT frequency AS f, starting AS s FROM meetings WHERE id = ?",
        id,
      );
    return { ...s, id, saved };
  }
  /** The meeting's placements of a planning run now: the push deletes managed instances not among them. */
  const placed = (db: Db, userId: string, id: string) =>
    plan(
      loadSnapshot(db, userId, "UTC", getSettings(db, userId), T0, 0).snapshot,
    ).placements.filter((p) => p.kind === "meeting" && p.itemId === id);
  const instances = (db: Db, id: string) =>
    all<{ key: string }>(
      db,
      "SELECT key FROM managed_events WHERE source_id = ? ORDER BY key",
      id,
    ).map((r) => r.key);

  const weekly = (everyWeeks: number, idealDays = [2]) => ({
    period: "weekly",
    everyWeeks,
    idealDays,
  });
  it.each([
    { was: "every 3 weeks", from: weekly(3), now: "every 2 weeks", to: weekly(2) },
    { was: "every day", from: { period: "daily" }, now: "every week", to: weekly(1) },
    { was: "every week", from: weekly(1), now: "every day", to: { period: "daily" } },
    {
      was: "every week",
      from: weekly(1),
      now: "every month",
      to: { period: "monthly", dayOfMonth: 1 },
    },
    {
      was: "every day",
      from: { period: "daily" },
      now: "every 3 days",
      to: { period: "daily", everyDays: 3 },
    },
  ])(
    "refuses to change a series from $was to $now, in the edit and its preview",
    async ({ from, to }) => {
      const { id, saved, status } = await seriesMeeting(from);
      const before = saved();
      const edit = sync1("Standup", { frequency: to });
      expect(await status("POST", `/meetings/preview?id=${id}`, edit)).toBe(400);
      expect(await status("PUT", `/meetings/${id}`, edit)).toBe(400);
      expect(saved()).toEqual(before);
    },
  );

  it("takes other ideal days and keeps every instance and the start date", async () => {
    const { db, owner, id, saved, call } = await seriesMeeting(weekly(3));
    const kept = instances(db, id);
    expect(kept.length).toBeGreaterThan(1);
    const edit = sync1("Standup", { frequency: weekly(3, [4]), starting: "2026-11-30" });
    await call("POST", `/meetings/preview?id=${id}`, edit);
    await call("PUT", `/meetings/${id}`, edit);
    expect(JSON.parse(saved()?.f ?? "{}")).toMatchObject({ idealDays: [4] });
    expect(saved()?.s).toBe("2026-10-19");
    // The next planning run keeps a placement for each instance: the push deletes none.
    expect(
      placed(db, owner.id, id)
        .map((p) => p.key)
        .sort(),
    ).toEqual(kept);
  });

  it("a meeting without a series takes any frequency", async () => {
    const { call, status } = setup();
    const plain = (await call("POST", "/meetings", sync1("Plain"))) as { id: string };
    const monthly = sync1("Plain", { frequency: { period: "monthly", dayOfMonth: 1 } });
    expect(await status("PUT", `/meetings/${plain.id}`, monthly)).toBe(200);
  });
});

describe("attendee hours", () => {
  function withColleague() {
    const s = setup();
    const colleague: User = ensureUser(s.db, "kim@example.com", "Kim", T0);
    run(
      s.db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
       VALUES ('acc-kim', ?, 'caldav', 'kim', 'kim@example.com', '', ?)`,
      colleague.id,
      T0,
    );
    return { ...s, colleague };
  }
  const changed = (db: Db, ownerId: string, t: number, lastPlannedAt: number) =>
    meetingItems(db, ownerId, t, t + 14 * DAY, lastPlannedAt, new Map()).items.map(
      (m) => m.changed,
    );

  it("places the meeting again when the attendee's meeting hours or time zone change, and only then", async () => {
    const { db, owner, colleague, call } = withColleague();
    await call("POST", "/meetings", sync1("Sync", { attendees: [{ email: "kim@example.com" }] }));
    const planned = T0 + 1;
    // The first plan records the hours it used.
    expect(changed(db, owner.id, T0 + DAY, planned)).toEqual([false]);
    // A set that the attendee's meetings do not use.
    run(
      db,
      "UPDATE hours_sets SET weekly = '{\"6\":[[600,700]]}' WHERE user_id = ? AND kind = 'personal'",
      colleague.id,
    );
    expect(changed(db, owner.id, T0 + DAY, planned)).toEqual([false]);
    run(db, "UPDATE users SET time_zone = 'Asia/Tokyo' WHERE id = ?", colleague.id);
    expect(changed(db, owner.id, T0 + 2 * DAY, planned)).toEqual([true]);
    const next = T0 + 2 * DAY + 1;
    expect(changed(db, owner.id, T0 + 3 * DAY, next)).toEqual([false]);
    run(
      db,
      "UPDATE hours_sets SET weekly = '{\"1\":[[600,700]]}' WHERE user_id = ? AND kind = 'meeting'",
      colleague.id,
    );
    expect(changed(db, owner.id, T0 + 3 * DAY, next)).toEqual([true]);
    // Deleting the meeting hours falls back to work hours: a change too.
    const after = T0 + 3 * DAY + 1;
    run(db, "DELETE FROM hours_sets WHERE user_id = ? AND kind = 'meeting'", colleague.id);
    expect(changed(db, owner.id, T0 + 4 * DAY, after)).toEqual([true]);
  });
});
