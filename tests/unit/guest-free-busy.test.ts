// Google free/busy for meeting guests who are not users here
// (docs/specs/meetings-flexible.md, attendee class `freebusy` and `none`),
// against an in-memory database and a fake Google Calendar HTTP API.
//
// Ways it can fail:
// 1. No query is made, or its busy time does not reach the meeting: the
//    meeting stays at the ideal time over the guest's busy time.
// 2. The query asks for optional guests or for users here, whose own calendars
//    are read already (class `user`).
// 3. A guest that Google gives no data for (errors) counts as free time
//    instead of unknown, or a failed query stops the planning run.
// 4. An organizer without a Google account sends a query.
// 5. The guest's free/busy holds the meeting's own invitation, so the meeting
//    moves away from itself on every run.
// 6. A slow Google holds up the plan, a long guest list goes in one request
//    that Google refuses, or each run asks again (no short cache).
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plan } from "../../src/scheduler/plan.ts";
import type { Interval } from "../../src/scheduler/timeset.ts";
import { ensureUser, upsertAccount } from "../../src/server/accounts.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { type Db, openDb, run } from "../../src/server/db.ts";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import {
  GUEST_FREE_BUSY_BATCH,
  GUEST_FREE_BUSY_TTL,
  guestFreeBusy,
} from "../../src/server/planner/meetings.ts";
import { loadSnapshot } from "../../src/server/planner/replan.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";
import { getSettings } from "../../src/server/settings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z"); // a Monday
const TUE_10 = Date.parse("2026-10-20T10:00:00Z");
const TUE_11 = Date.parse("2026-10-20T11:00:00Z");
const FREEBUSY = "https://www.googleapis.com/calendar/v3/freeBusy";
const GUEST = "guest@example.com";

type Reply = (items: string[]) => Response;
let asked: string[][];
let reply: Reply;

beforeEach(() => {
  asked = [];
  reply = (items) =>
    Response.json({
      calendars: Object.fromEntries(
        items.map((id) => [
          id,
          id === GUEST
            ? {
                busy: [
                  { start: new Date(TUE_10).toISOString(), end: new Date(TUE_11).toISOString() },
                ],
              }
            : { busy: [] },
        ]),
      ),
    });
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (String(input) !== FREEBUSY || init?.method !== "POST")
      return Response.json({ error: { message: "unexpected" } }, { status: 404 });
    const body = JSON.parse(String(init.body)) as { items: { id: string }[] };
    const items = body.items.map((i) => i.id);
    asked.push(items);
    return reply(items);
  });
});

afterEach(() => vi.unstubAllGlobals());

function setup(google: boolean) {
  const db = openDb(":memory:");
  const box = new SecretBox(randomBytes(32).toString("base64"));
  const owner = ensureUser(db, "owner@example.com", "Owner", T0);
  const accountId = upsertAccount(db, box, {
    userId: owner.id,
    provider: google ? "google" : "caldav",
    externalId: "owner-sub",
    email: owner.email,
    credentials: {},
  });
  // A colleague who is a user here: class `user`, never asked of Google.
  const colleague = ensureUser(db, "colleague@example.com", "Colleague", T0);
  upsertAccount(db, box, {
    userId: colleague.id,
    provider: "caldav",
    externalId: "colleague",
    email: colleague.email,
    credentials: {},
  });
  const sync = { request() {} } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", owner);
    await next();
  });
  app.route(
    "/api",
    meetingRoutes(db, sync, () => T0),
  );
  const provider = () =>
    new GoogleProvider(
      new GoogleCalendarApi({ getAccessToken: async () => "token", maxAttempts: 1 }),
      "UTC",
    );
  run(
    db,
    "INSERT INTO calendars (id, account_id, provider_id, name, is_primary) VALUES ('cal', ?, 'cal', 'Work', 1)",
    accountId,
  );
  return { db, owner, app, provider };
}

async function addMeeting(s: ReturnType<typeof setup>): Promise<string> {
  const res = await s.app.request("/api/meetings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Sync",
      attendees: [
        { email: GUEST },
        { email: "Optional@example.com", required: false },
        { email: "colleague@example.com" },
      ],
      frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
      idealTime: "10:00",
      durationMinutes: 30,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** The meeting's first start, planned with the given guest busy time. */
function placedMeeting(db: Db, userId: string, id: string, guestBusy?: Map<string, Interval[]>) {
  const snap = loadSnapshot(db, userId, "UTC", getSettings(db, userId), T0, 0, guestBusy);
  return plan(snap.snapshot)
    .placements.filter((p) => p.kind === "meeting" && p.itemId === id)
    .sort((a, b) => a.start - b.start);
}

function firstStart(db: Db, userId: string, id: string, guestBusy?: Map<string, Interval[]>) {
  const starts = placedMeeting(db, userId, id, guestBusy).map((p) => p.start);
  return starts[0] === undefined ? null : new Date(starts[0]).toISOString();
}

const window = [T0, T0 + 21 * 86_400_000] as const;

describe("Google free/busy of meeting guests", () => {
  it("asks Google for required guests who are not users here and places the meeting around their busy time", async () => {
    const s = setup(true);
    const id = await addMeeting(s);
    const busy = await guestFreeBusy(s.db, s.provider, s.owner.id, ...window);
    expect(asked).toEqual([[GUEST]]);
    expect(busy.get(GUEST)).toEqual([{ start: TUE_10, end: TUE_11 }]);
    // Without the guest's busy time the meeting takes its ideal time; with it, the nearest free time.
    expect(firstStart(s.db, s.owner.id, id)).toBe("2026-10-20T10:00:00.000Z");
    expect(firstStart(s.db, s.owner.id, id, busy)).toBe("2026-10-20T09:30:00.000Z");
  });

  it("leaves a guest with no data, or every guest after a failed query, unknown", async () => {
    const s = setup(true);
    const id = await addMeeting(s);
    reply = (items) =>
      Response.json({
        calendars: Object.fromEntries(
          items.map((i) => [i, { errors: [{ domain: "global", reason: "notFound" }], busy: [] }]),
        ),
      });
    const none = await guestFreeBusy(s.db, s.provider, s.owner.id, ...window);
    expect(none.size).toBe(0);
    expect(firstStart(s.db, s.owner.id, id, none)).toBe("2026-10-20T10:00:00.000Z");
    const later = [window[0] + GUEST_FREE_BUSY_TTL, window[1] + GUEST_FREE_BUSY_TTL] as const;

    reply = () =>
      Response.json(
        { error: { code: 403, message: "Forbidden", errors: [{ reason: "forbidden" }] } },
        { status: 403 },
      );
    const failed = await guestFreeBusy(s.db, s.provider, s.owner.id, ...later);
    expect(failed.size).toBe(0);
    expect(asked).toHaveLength(2);
  });

  it("sends no query when the organizer has no Google account", async () => {
    const s = setup(false);
    await addMeeting(s);
    const busy = await guestFreeBusy(s.db, s.provider, s.owner.id, ...window);
    expect(busy.size).toBe(0);
    expect(asked).toEqual([]);
  });

  it("does not count the meeting's own invitation in the guest's busy time", async () => {
    const s = setup(true);
    const id = await addMeeting(s);
    // First run: the guest is free, so each occurrence takes Tuesday 10:00.
    reply = (items) =>
      Response.json({ calendars: Object.fromEntries(items.map((i) => [i, { busy: [] }])) });
    const first = placedMeeting(
      s.db,
      s.owner.id,
      id,
      await guestFreeBusy(s.db, s.provider, s.owner.id, ...window),
    );
    expect(first.length).toBeGreaterThan(0);
    for (const p of first)
      run(
        s.db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
         VALUES (?, ?, 'cal', ?, ?, 'meeting', ?, ?, ?, 1, 'Sync')`,
        p.key,
        s.owner.id,
        `ev-${p.key}`,
        p.key,
        id,
        p.start,
        p.end,
      );
    // The guest's calendar now holds the invitations: Google reports them as busy,
    // with one more busy hour of the guest's own on the first Tuesday at 13:00.
    const own = Date.parse("2026-10-20T13:00:00Z");
    reply = (items) =>
      Response.json({
        calendars: Object.fromEntries(
          items.map((i) => [
            i,
            {
              busy: [
                ...first.map((p) => ({
                  start: new Date(p.start).toISOString(),
                  end: new Date(p.end).toISOString(),
                })),
                {
                  start: new Date(own).toISOString(),
                  end: new Date(own + 3_600_000).toISOString(),
                },
              ],
            },
          ]),
        ),
      });
    const later = [window[0] + GUEST_FREE_BUSY_TTL, window[1] + GUEST_FREE_BUSY_TTL] as const;
    const busy = await guestFreeBusy(s.db, s.provider, s.owner.id, ...later);
    expect(busy.get(GUEST)?.length).toBe(first.length + 1);
    const second = placedMeeting(s.db, s.owner.id, id, busy);
    expect(second.map((p) => [p.key, p.start])).toEqual(first.map((p) => [p.key, p.start]));
    expect(second.some((p) => p.conflict)).toBe(false);
  });

  it("gives up on a slow Google within the time limit and counts guests as unknown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const s = setup(true);
      await addMeeting(s);
      vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
      const pending = guestFreeBusy(s.db, s.provider, s.owner.id, ...window);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits a long guest list into requests of at most the batch size and asks once per short period", async () => {
    const s = setup(true);
    const guests = Array.from({ length: GUEST_FREE_BUSY_BATCH + 5 }, (_, i) => ({
      email: `g${String(i).padStart(3, "0")}@example.com`,
    }));
    // A meeting holds at most 50 guests: two meetings give the long list.
    for (const part of [guests.slice(0, 40), guests.slice(40)]) {
      const res = await s.app.request("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Town hall",
          attendees: part,
          frequency: { period: "weekly", everyWeeks: 1, idealDays: [3] },
          idealTime: "10:00",
          durationMinutes: 30,
        }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    const busy = await guestFreeBusy(s.db, s.provider, s.owner.id, ...window);
    expect(asked.map((a) => a.length)).toEqual([GUEST_FREE_BUSY_BATCH, 5]);
    expect(busy.size).toBe(GUEST_FREE_BUSY_BATCH + 5);
    // A second run soon after uses the answer it has; one after the cache time asks again.
    await guestFreeBusy(s.db, s.provider, s.owner.id, window[0] + 60_000, window[1] + 60_000);
    expect(asked).toHaveLength(2);
    await guestFreeBusy(s.db, s.provider, s.owner.id, window[0] + GUEST_FREE_BUSY_TTL, window[1]);
    expect(asked).toHaveLength(4);
  });
});
