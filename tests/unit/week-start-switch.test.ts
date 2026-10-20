// A week start read from Google (docs/specs/settings-profile.md PRF-2, edge
// case 3) against an in-memory database and a fake Google Calendar API.
//
// Ways it can fail:
// 1. The first calendar list sync after deploy flips the week start at once:
//    every weekly meeting occurrence gets a new planner key, so the push
//    deletes the placed events and makes new ones (new invitations to guests).
// 2. The new week start never takes effect, or takes effect before the next
//    week.
// 3. At the switch the placed weekly occurrences keep their old keys, so the
//    push deletes and recreates them then.
// 4. A skipped week (a dismissed key of the old week) or a decline waiting for
//    its move keeps the old key: the skipped week comes back with a new
//    invitation, or the decline is never completed.
// 5. A Sunday-to-Monday switch on a Sunday leaves the occurrence already held
//    this week under its old key, so the plan makes a second one that week.
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plan } from "../../src/scheduler/plan.ts";
import { googleAccessToken, upsertGoogleLogin } from "../../src/server/accounts.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import { GOOGLE_SCOPES } from "../../src/server/google/oauth.ts";
import { loadSnapshot } from "../../src/server/planner/replan.ts";
import { applyPendingWeekStart } from "../../src/server/planner/week-start.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";
import { getSettings } from "../../src/server/settings.ts";
import { syncCalendarList } from "../../src/server/sync/pull.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const DAY = 86_400_000;
const MON = Date.parse("2026-10-19T08:00:00Z"); // a Monday
const NEXT_MON = MON + 7 * DAY;
const API = "https://www.googleapis.com/calendar/v3";

let googleWeekStart = "0";

beforeEach(() => {
  googleWeekStart = "0";
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.href.startsWith(`${API}/users/me/calendarList`))
      return Response.json({
        items: [{ id: "ana@example.com", summary: "Ana", primary: true, accessRole: "owner" }],
      });
    // Google's default for a US locale: the week starts on Sunday.
    if (url.href.startsWith(`${API}/users/me/settings`))
      return Response.json({ items: [{ id: "weekStart", value: googleWeekStart }] });
    return Response.json({ error: { message: "unexpected" } }, { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

async function setup(stored: 1 | 7 = 1) {
  const db = openDb(":memory:");
  const box = new SecretBox(randomBytes(32).toString("base64"));
  const { user, accountId } = upsertGoogleLogin(
    db,
    box,
    { sub: "sub-ana", email: "ana@example.com", name: "Ana", emailVerified: true },
    {
      accessToken: "a",
      expiresAt: MON + 3_600_000,
      refreshToken: "r",
      scope: GOOGLE_SCOPES.join(" "),
    },
    MON,
  );
  run(db, "UPDATE users SET time_zone = 'UTC' WHERE id = ?", user.id);
  const provider = new GoogleProvider(
    new GoogleCalendarApi({
      getAccessToken: () => googleAccessToken(db, box, accountId, { now: MON }),
      maxAttempts: 1,
    }),
    "UTC",
  );
  await syncCalendarList(db, provider, accountId, user.id, MON);
  // Only the calendar list: the settings read waits for a placed meeting below.
  run(
    db,
    "UPDATE users SET settings = ? WHERE id = ?",
    JSON.stringify({ weekStart: stored }),
    user.id,
  );
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    meetingRoutes(db, { request() {} } as unknown as SyncService, () => MON),
  );
  const res = await app.request("/api/meetings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Weekly sync",
      attendees: [{ email: "guest@example.com" }],
      frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
      idealTime: "10:00",
      durationMinutes: 30,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return { db, user, accountId, provider };
}

const calendarOf = (db: Db) =>
  (one<{ id: string }>(db, "SELECT id FROM calendars WHERE is_primary = 1") as { id: string }).id;

function desired(db: Db, userId: string, now: number) {
  const s = loadSnapshot(db, userId, "UTC", getSettings(db, userId), now, 0);
  return plan(s.snapshot)
    .placements.filter((p) => p.kind === "meeting")
    .map((p) => ({ key: p.key, start: p.start, end: p.end }));
}

/** Stores the placements as the push would after it writes them. */
function place(db: Db, userId: string, items: { key: string; start: number; end: number }[]) {
  const cal = calendarOf(db);
  const source = (one<{ id: string }>(db, "SELECT id FROM meetings") as { id: string }).id;
  for (const p of items)
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
       VALUES (?, ?, ?, ?, ?, 'meeting', ?, ?, ?, 1, 'Weekly sync')`,
      p.key,
      userId,
      cal,
      `ev-${p.key}`,
      p.key,
      source,
      p.start,
      p.end,
    );
}

/** What the push would do: rows without a wanted key are deleted, keys without a row created. */
function diff(db: Db, userId: string, now: number) {
  const want = desired(db, userId, now);
  const rows = all<{ key: string; start_ms: number }>(
    db,
    "SELECT key, start_ms FROM managed_events WHERE user_id = ? AND start_ms > ?",
    userId,
    now,
  );
  const wanted = new Set(want.map((w) => w.key));
  const have = new Set(rows.map((r) => r.key));
  return {
    deleted: rows.filter((r) => !wanted.has(r.key)).map((r) => r.key),
    created: want.filter((w) => !have.has(w.key)),
  };
}

describe("a week start read from Google", () => {
  it("the first sync after deploy keeps every planner key: nothing is deleted or made again", async () => {
    const s = await setup();
    place(s.db, s.user.id, desired(s.db, s.user.id, MON));
    expect(diff(s.db, s.user.id, MON)).toEqual({ deleted: [], created: [] });

    await syncCalendarList(s.db, s.provider, s.accountId, s.user.id, MON);
    applyPendingWeekStart(s.db, s.user.id, "UTC", MON);
    // From the next week on (edge case 3): this week keeps Monday.
    expect(getSettings(s.db, s.user.id).weekStart).toBe(1);
    expect(diff(s.db, s.user.id, MON)).toEqual({ deleted: [], created: [] });
  });

  it("takes the new week start in the next week and moves the placed occurrences to the new keys", async () => {
    const s = await setup();
    place(s.db, s.user.id, desired(s.db, s.user.id, MON));
    await syncCalendarList(s.db, s.provider, s.accountId, s.user.id, MON);
    applyPendingWeekStart(s.db, s.user.id, "UTC", NEXT_MON - DAY);
    expect(getSettings(s.db, s.user.id).weekStart).toBe(1);

    const before = all<{ start_ms: number }>(
      s.db,
      "SELECT start_ms FROM managed_events WHERE start_ms > ? ORDER BY start_ms",
      NEXT_MON,
    );
    applyPendingWeekStart(s.db, s.user.id, "UTC", NEXT_MON);
    expect(getSettings(s.db, s.user.id).weekStart).toBe(7);
    // Sunday weeks: the Tuesday occurrence of the week of 26 October is in the week of 25 October.
    expect(
      one<{ key: string }>(
        s.db,
        "SELECT key FROM managed_events WHERE start_ms = ?",
        Date.parse("2026-10-27T10:00:00Z"),
      )?.key,
    ).toMatch(/:2026-10-25$/);
    // Only the week that the planning window gains is new; nothing placed is deleted.
    const after = diff(s.db, s.user.id, NEXT_MON);
    expect(after.deleted).toEqual([]);
    const last = before.at(-1)?.start_ms ?? 0;
    expect(after.created.filter((c) => c.start <= last)).toEqual([]);
    expect(
      all<{ start_ms: number }>(
        s.db,
        "SELECT start_ms FROM managed_events WHERE start_ms > ? ORDER BY start_ms",
        NEXT_MON,
      ),
    ).toEqual(before);
  });

  it("moves a skipped week and a waiting decline to the new keys, so the skipped week stays empty", async () => {
    const s = await setup();
    place(s.db, s.user.id, desired(s.db, s.user.id, MON));
    const meeting = (one<{ id: string }>(s.db, "SELECT id FROM meetings") as { id: string }).id;
    // Skip the week of 2 November: the key is dismissed and the event deleted (MEET-02 rule 20).
    run(s.db, "DELETE FROM managed_events WHERE key = ?", `meeting:${meeting}:2026-11-02`);
    run(
      s.db,
      "INSERT INTO dismissed_keys (user_id, key) VALUES (?, ?)",
      s.user.id,
      `meeting:${meeting}:2026-11-02`,
    );
    // A guest declined the occurrence of 27 October; its move is pending.
    run(
      s.db,
      `INSERT INTO meeting_changes (user_id, meeting_id, occurrence_key, at, old_start, old_end, actor, reason)
       VALUES (?, ?, ?, ?, ?, ?, 'guest@example.com', 'declined')`,
      s.user.id,
      meeting,
      `meeting:${meeting}:2026-10-26`,
      MON,
      Date.parse("2026-10-27T10:00:00Z"),
      Date.parse("2026-10-27T10:30:00Z"),
    );
    const inSkipped = (now: number) =>
      desired(s.db, s.user.id, now).filter(
        (p) =>
          p.start >= Date.parse("2026-11-01T00:00:00Z") &&
          p.start < Date.parse("2026-11-08T00:00:00Z"),
      );
    expect(inSkipped(NEXT_MON)).toEqual([]);

    await syncCalendarList(s.db, s.provider, s.accountId, s.user.id, MON);
    applyPendingWeekStart(s.db, s.user.id, "UTC", NEXT_MON);
    expect(getSettings(s.db, s.user.id).weekStart).toBe(7);
    expect(inSkipped(NEXT_MON)).toEqual([]);
    expect(all(s.db, "SELECT key FROM dismissed_keys")).toEqual([
      { key: `meeting:${meeting}:2026-11-01` },
    ]);
    expect(all(s.db, "SELECT occurrence_key FROM meeting_changes")).toEqual([
      { occurrence_key: `meeting:${meeting}:2026-10-25` },
    ]);
  });

  it("a Sunday-to-Monday switch on a Sunday keeps this week's held occurrence as done: no second one that week", async () => {
    googleWeekStart = "1";
    const s = await setup(7);
    place(s.db, s.user.id, desired(s.db, s.user.id, MON));
    const meeting = (one<{ id: string }>(s.db, "SELECT id FROM meetings") as { id: string }).id;
    await syncCalendarList(s.db, s.provider, s.accountId, s.user.id, MON);
    const sunday = Date.parse("2026-10-25T12:00:00Z");
    applyPendingWeekStart(s.db, s.user.id, "UTC", sunday);
    expect(getSettings(s.db, s.user.id).weekStart).toBe(1);
    // The occurrence of Tuesday 20 October is past and is in the Monday week of 19 October.
    expect(
      one<{ key: string }>(
        s.db,
        "SELECT key FROM managed_events WHERE start_ms = ?",
        Date.parse("2026-10-20T10:00:00Z"),
      )?.key,
    ).toBe(`meeting:${meeting}:2026-10-19`);
    const after = diff(s.db, s.user.id, sunday);
    expect(after.deleted).toEqual([]);
    expect(after.created.filter((c) => c.key.endsWith(":2026-10-19"))).toEqual([]);
  });
});
