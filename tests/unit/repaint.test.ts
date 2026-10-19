// Repainting managed events (docs/specs/events-categories-and-colors.md rules
// 8, 12, 16) against a fake Google Calendar API.
//
// Ways it can fail:
// 1. The repaint sends the etag Tempoloom stored when it last wrote the event.
//    A color the user changed in the calendar gives the event a new etag, so
//    Google answers 412 and the event keeps the wrong color.
// 2. A "repaint all" request is used up when a write fails, so the colors
//    stay wrong until the user asks again.
// 3. A "repaint all" request never clears while an account needs a new login,
//    so every run repaints all and puts back colors the user sets.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { type Db, one, openDb, run } from "../../src/server/db.ts";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import { OAuthError } from "../../src/server/google/oauth.ts";
import { type PaintJob, requestRepaint, runPaint } from "../../src/server/planner/repaint.ts";
import { replanUser } from "../../src/server/planner/replan.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";
import { type CalendarProvider, ProviderError } from "../../src/server/providers/types.ts";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const HOUR = 3_600_000;

interface Call {
  method: string;
  ifMatch: string | null;
  colorId: string | undefined;
}

/** A Google Calendar API that answers 412 unless if-match is the event's current etag. */
function fakeGoogle(current: { etag: string }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const ifMatch = headers["if-match"] ?? null;
    calls.push({
      method: init.method ?? "GET",
      ifMatch,
      colorId: body.colorId as string | undefined,
    });
    if (ifMatch && ifMatch !== current.etag)
      return new Response(
        JSON.stringify({ error: { code: 412, message: "Precondition Failed" } }),
        {
          status: 412,
        },
      );
    current.etag = `"${calls.length}-new"`;
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    return Response.json({
      id,
      status: "confirmed",
      etag: current.etag,
      summary: "Travel",
      start: { dateTime: new Date(NOW - 3 * HOUR).toISOString() },
      end: { dateTime: new Date(NOW - 2 * HOUR).toISOString() },
      ...(body.colorId === undefined ? {} : { colorId: body.colorId }),
      extendedProperties: { private: { tl: "1" } },
    });
  });
  const provider = new GoogleProvider(
    new GoogleCalendarApi({ getAccessToken: async () => "token", maxAttempts: 1 }),
    "UTC",
  );
  return { calls, provider };
}

/**
 * A managed buffer that ended an hour ago; its category color is 2. Tempoloom
 * wrote it with `written` and etag "m-old"; the user then changed its color in
 * the calendar to 5, so the cached event has etag "e-new".
 */
function setup(written: string): { db: Db; userId: string } {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW - 30 * 86_400_000);
  run(db, "UPDATE users SET first_sign_in_at = ? WHERE id = ?", NOW, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'google', 'sub-1', 'owner@example.com', '', ?, 1)`,
    user.id,
    NOW,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', 'owner@example.com', 'Work', 1, 1, 1)`,
  );
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms,
       end_ms, busy, title, color_id, etag)
     VALUES ('m1', ?, 'cal', 'ev1', 'buffer:b1:x', 'buffer', 'b1', ?, ?, 1, 'Travel', ?, '"m-old"')`,
    user.id,
    NOW - 3 * HOUR,
    NOW - 2 * HOUR,
    written,
  );
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, color_id, etag, private_props)
     VALUES ('cal', 'ev1', 'Travel', ?, ?, '5', '"e-new"', '{"tl":"1"}')`,
    NOW - 3 * HOUR,
    NOW - 2 * HOUR,
  );
  return { db, userId: user.id };
}

/** One scheduler run, then the repaint job it hands off (rule 16). */
async function runOnce(db: Db, userId: string, provider: GoogleProvider) {
  const result = (await replanUser(
    { db, provider: () => provider, now: NOW, baseUrl: "http://localhost" },
    userId,
  )) as { paint?: PaintJob } | null;
  if (result?.paint) await runPaint({ db, provider: () => provider }, userId, result.paint);
}

afterEach(() => vi.unstubAllGlobals());

const requested = (db: Db) =>
  one<{ at: number | null }>(db, "SELECT repaint_requested_at AS at FROM users")?.at ?? null;

describe("repaint", () => {
  it("writes a new category color with the cached etag (rule 8)", async () => {
    const { db, userId } = setup("3");
    const google = fakeGoogle({ etag: '"e-new"' });
    await runOnce(db, userId, google.provider);
    const writes = google.calls.filter((c) => c.colorId !== undefined);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.ifMatch).toBe('"e-new"');
    const cached = one<{ color_id: string | null }>(
      db,
      "SELECT color_id FROM events WHERE event_id = 'ev1'",
    );
    expect(cached?.color_id).toBe("2");
  });

  it("repaint all puts back a color changed in the calendar, and keeps the request until a write succeeds (rule 12)", async () => {
    const { db, userId } = setup("2");
    // The event changed again after the last read: the first write gets 412.
    const google = fakeGoogle({ etag: '"newer"' });
    requestRepaint(db, userId, NOW);
    await runOnce(db, userId, google.provider);
    expect(google.calls.filter((c) => c.colorId !== undefined)).toHaveLength(1);
    expect(requested(db)).toBe(NOW);
    // The next read brings the new etag; the request is still there.
    run(db, `UPDATE events SET etag = '"newer"' WHERE event_id = 'ev1'`);
    await runOnce(db, userId, google.provider);
    const writes = google.calls.filter((c) => c.colorId !== undefined);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.ifMatch).toBe('"newer"');
    expect(requested(db)).toBeNull();
    // Done: a third run writes nothing.
    await runOnce(db, userId, google.provider);
    expect(google.calls.filter((c) => c.colorId !== undefined)).toHaveLength(2);
  });

  it("clears a repaint all request when only an account that needs a new login is left (rule 12)", async () => {
    const { db, userId } = setup("2");
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main, status)
       VALUES ('acc2', ?, 'google', 'sub-2', 'other@example.com', '', ?, 0, 'reauth_required')`,
      userId,
      NOW,
    );
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
       VALUES ('cal2', 'acc2', 'other@example.com', 'Other', 1, 1, 1)`,
    );
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms,
         end_ms, busy, title, color_id, etag)
       VALUES ('m2', ?, 'cal2', 'ev2', 'buffer:b2:x', 'buffer', 'b2', ?, ?, 1, 'Travel', '2', '"m2"')`,
      userId,
      NOW - 3 * HOUR,
      NOW - 2 * HOUR,
    );
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, color_id, etag, private_props)
       VALUES ('cal2', 'ev2', 'Travel', ?, ?, '5', '"e2"', '{"tl":"1"}')`,
      NOW - 3 * HOUR,
      NOW - 2 * HOUR,
    );
    const google = fakeGoogle({ etag: '"e-new"' });
    // Every call for the account that needs a new login fails like the real token store.
    const locked = new Proxy({} as CalendarProvider, {
      get: () => async () => {
        throw new OAuthError("reauth_required", "Account needs a new login");
      },
    });
    const provider = (id: string) => (id === "acc2" ? locked : google.provider);
    requestRepaint(db, userId, NOW);
    const result = (await replanUser(
      { db, provider, now: NOW, baseUrl: "http://localhost" },
      userId,
    )) as { paint: PaintJob };
    await runPaint({ db, provider }, userId, result.paint);
    expect(google.calls.filter((c) => c.colorId !== undefined)).toHaveLength(1);
    expect(requested(db)).toBeNull();
  });

  it("clears a repaint all request when a write fails because the login is no longer valid (rule 12)", async () => {
    const { db, userId } = setup("2");
    requestRepaint(db, userId, NOW);
    const badPassword = new Proxy({} as CalendarProvider, {
      get: () => async () => {
        throw new ProviderError("auth", 401, "Unauthorized");
      },
    });
    await runPaint({ db, provider: () => badPassword }, userId, {
      paints: [{ calendarId: "cal", eventId: "ev1", series: false, color: "2", managedId: "m1" }],
      requestedAt: NOW,
    });
    expect(requested(db)).toBeNull();
  });
});
