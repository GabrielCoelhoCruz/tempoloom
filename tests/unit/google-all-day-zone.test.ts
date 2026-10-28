// An all-day event on a Google calendar keeps its date in the user's zone
// (src/server/providers/google.ts reads a date-only start in the provider's
// zone), against an in-memory database and a fake Google token endpoint,
// calendar list and event list.
//
// Ways it can fail:
// 1. The first sync of an operator-connected account reads the events with
//    the zone that the user had before the calendar list set it (UTC). A
//    one-day event on 2026-11-05 then ends at 01:00 on 2026-11-06 in Berlin,
//    and shows as "2026-11-05–2026-11-06 (all day)".
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../../src/server/crypto.ts";
import { one, openDb } from "../../src/server/db.ts";
import { connectGoogleOauth } from "../../src/server/google/connect.ts";
import { allDayWhen, zoneOf } from "../../src/server/preview.ts";
import { SyncService } from "../../src/server/sync/service.ts";
import { localToUtc } from "../../src/shared/time.ts";

const CLIENT = { clientId: "client-1", clientSecret: "secret-1" };
const SUB = "google-sub-42";
const GOOGLE_EMAIL = "tester@example.com";
const TEST_CAL = "test123@group.calendar.google.com";
const ZONE = "Europe/Berlin";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = `${b64({ alg: "RS256" })}.${b64({ sub: SUB, email: GOOGLE_EMAIL, email_verified: true })}.sig`;

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "access-1", expires_in: 3600, id_token: idToken });
    if (url.pathname === "/calendar/v3/users/me/calendarList")
      return Response.json({
        items: [
          // The account's own primary calendar is in another zone than the test calendar.
          {
            id: GOOGLE_EMAIL,
            summary: GOOGLE_EMAIL,
            primary: true,
            accessRole: "owner",
            timeZone: "America/Sao_Paulo",
          },
          { id: TEST_CAL, summary: "[tl-test] tempoloom-e2e", accessRole: "owner", timeZone: ZONE },
        ],
      });
    if (url.pathname === `/calendar/v3/calendars/${encodeURIComponent(TEST_CAL)}/events`)
      return Response.json({
        items: [
          // As tests/e2e/fixtures.ts addAllDay writes it: no time zone, the end date is exclusive.
          {
            id: "offsite",
            status: "confirmed",
            summary: "Offsite",
            start: { date: "2026-11-05" },
            end: { date: "2026-11-06" },
          },
        ],
        nextSyncToken: "token-1",
      });
    return Response.json({ items: [] });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("all-day events on a Google calendar", () => {
  it("the first sync of an operator-connected account reads them in the zone the calendar list sets", async () => {
    const db = openDb(":memory:");
    const box = new SecretBox(randomBytes(32).toString("base64"));
    const { userId } = await connectGoogleOauth(db, box, CLIENT, "refresh-1", {
      email: "e2e@tempoloom.test",
      calendar: TEST_CAL,
    });
    const sync = new SyncService({
      db,
      box,
      oauth: { ...CLIENT, redirectUri: "http://localhost/cb" },
      serviceKey: undefined,
      now: () => Date.parse("2026-11-02T08:00:00Z"),
      intervalMs: 60_000,
      baseUrl: "http://localhost",
      log: () => {},
    });
    await sync.runNow(userId);
    expect(zoneOf(db, userId)).toBe(ZONE);
    const ev = one<{ start_ms: number; end_ms: number }>(
      db,
      "SELECT start_ms, end_ms FROM events WHERE event_id = 'offsite'",
    );
    expect(ev).toEqual({
      start_ms: localToUtc(ZONE, "2026-11-05", 0),
      end_ms: localToUtc(ZONE, "2026-11-06", 0),
    });
    expect(allDayWhen(ZONE, ev?.start_ms ?? 0, ev?.end_ms ?? 0)).toBe("Thu 2026-11-05 (all day)");
  });
});
