// Profile data from Google (docs/specs/settings-profile.md PRF-2 to PRF-5),
// against an in-memory database and a fake Google token endpoint and
// Calendar API.
//
// Ways it can fail:
// 1. The picture is read but not kept, so the profile and booking pages show none.
// 2. The name and picture are taken only when the user is made: a later change
//    in Google never arrives, neither at sign-in nor at the token refresh that
//    runs at least daily.
// 3. An added Google account that is not the main account overwrites the
//    profile of the user.
// 4. A picture the user hides in Google stays at the old value.
// 5. Week start, time format and date format are not read from the Google
//    Calendar settings, or a grant without the settings scope stops the
//    calendar list sync, or logs a failure at every sync.
// 6. A token refresh whose ID token lacks a claim fails the API call, or wipes
//    the name or picture.
// 7. A picture URL that is not https reaches the pages.
// 8. A Google week start that differs from the planning week start changes the
//    planning week, so weekly meeting keys change and the push deletes and
//    recreates their events (applying it to planning is not built).
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plan } from "../../src/scheduler/plan.ts";
import { googleAccessToken, upsertGoogleLogin } from "../../src/server/accounts.ts";
import { publicBookingRoutes } from "../../src/server/api/booking.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import { GOOGLE_SCOPES, type GoogleIdentity } from "../../src/server/google/oauth.ts";
import type { Mailer } from "../../src/server/mail.ts";
import { loadSnapshot } from "../../src/server/planner/replan.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";
import { getSettings } from "../../src/server/settings.ts";
import { syncCalendarList } from "../../src/server/sync/pull.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const CLIENT = { clientId: "client-1", clientSecret: "secret-1", redirectUri: "http://x/cb" };
const API = "https://www.googleapis.com/calendar/v3";
const PIC_1 = "https://lh3.googleusercontent.com/a/one";
const PIC_2 = "https://lh3.googleusercontent.com/a/two";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (claims: Record<string, unknown>) =>
  `${b64({ alg: "RS256" })}.${b64({ email_verified: true, ...claims })}.sig`;

let refreshClaims: Record<string, unknown>;
let settings: Response | (() => Response);
let requests: string[];

beforeEach(() => {
  requests = [];
  refreshClaims = {};
  settings = () =>
    Response.json({
      items: [
        { id: "weekStart", value: "0" },
        { id: "format24HourTime", value: "false" },
        { id: "dateFieldOrder", value: "MDY" },
        { id: "timezone", value: "America/New_York" },
      ],
    });
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.href === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "fresh-token",
        expires_in: 3600,
        scope: "openid",
        token_type: "Bearer",
        id_token: idToken(refreshClaims),
      });
    if (url.href.startsWith(`${API}/users/me/calendarList`))
      return Response.json({
        items: [{ id: "ana@example.com", summary: "Ana", primary: true, accessRole: "owner" }],
      });
    if (url.href.startsWith(`${API}/users/me/settings`))
      return typeof settings === "function" ? settings() : settings;
    return Response.json({ error: { message: "unexpected" } }, { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const db = openDb(":memory:");
  const box = new SecretBox(randomBytes(32).toString("base64"));
  return { db, box };
}

const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  sub: "sub-ana",
  email: "ana@example.com",
  name: "Ana Lima",
  picture: PIC_1,
  emailVerified: true,
  ...over,
});

const tokens = {
  accessToken: "a",
  expiresAt: T0 + 3_600_000,
  refreshToken: "r",
  scope: GOOGLE_SCOPES.join(" "),
};

const profile = (db: Db, id: string) =>
  one<{ name: string; avatar_url: string }>(
    db,
    "SELECT name, avatar_url FROM users WHERE id = ?",
    id,
  );

const provider = (db: Db, box: SecretBox, accountId: string) =>
  new GoogleProvider(
    new GoogleCalendarApi({
      getAccessToken: (fresh) =>
        googleAccessToken(db, box, accountId, { oauth: CLIENT, now: T0, fresh: fresh === true }),
      maxAttempts: 1,
    }),
    "UTC",
  );

describe("name and picture from Google", () => {
  it("keeps the picture and follows name and picture changes at each sign-in", () => {
    const { db, box } = setup();
    const { user } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    expect(profile(db, user.id)).toEqual({ name: "Ana Lima", avatar_url: PIC_1 });
    upsertGoogleLogin(db, box, identity({ name: "Ana Souza", picture: PIC_2 }), tokens, T0);
    expect(profile(db, user.id)).toEqual({ name: "Ana Souza", avatar_url: PIC_2 });
    // A picture hidden from other people is not in the token: no picture (PRF-5).
    const { picture: _hidden, ...noPicture } = identity({ name: "Ana Souza" });
    upsertGoogleLogin(db, box, noPicture, tokens, T0);
    expect(profile(db, user.id)).toEqual({ name: "Ana Souza", avatar_url: "" });
  });

  it("an added Google account that is not the main account leaves the profile alone", () => {
    const { db, box } = setup();
    const { user } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    upsertGoogleLogin(
      db,
      box,
      identity({ sub: "sub-work", email: "ana@work.example", name: "Work Ana", picture: PIC_2 }),
      tokens,
      T0,
      undefined,
      user.id,
    );
    expect(profile(db, user.id)).toEqual({ name: "Ana Lima", avatar_url: PIC_1 });
  });

  it("takes a changed name and picture at the token refresh, which runs at least daily", async () => {
    const { db, box } = setup();
    const { user, accountId } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    run(db, "UPDATE accounts SET access_expires_at = 0 WHERE id = ?", accountId);
    refreshClaims = { sub: "sub-ana", email: "ana@example.com", name: "Ana L.", picture: PIC_2 };
    expect(await googleAccessToken(db, box, accountId, { oauth: CLIENT, now: T0 })).toBe(
      "fresh-token",
    );
    expect(profile(db, user.id)).toEqual({ name: "Ana L.", avatar_url: PIC_2 });
  });

  it("a refresh ID token without name or picture keeps them, and a bad ID token does not fail the refresh", async () => {
    const { db, box } = setup();
    const { user, accountId } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    run(db, "UPDATE accounts SET access_expires_at = 0 WHERE id = ?", accountId);
    refreshClaims = { sub: "sub-ana", email: "ana@example.com" };
    expect(await googleAccessToken(db, box, accountId, { oauth: CLIENT, now: T0 })).toBe(
      "fresh-token",
    );
    expect(profile(db, user.id)).toEqual({ name: "Ana Lima", avatar_url: PIC_1 });
    run(db, "UPDATE accounts SET access_expires_at = 0 WHERE id = ?", accountId);
    refreshClaims = { name: "No subject" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await googleAccessToken(db, box, accountId, { oauth: CLIENT, now: T0 })).toBe(
        "fresh-token",
      );
    } finally {
      log.mockRestore();
    }
    expect(profile(db, user.id)).toEqual({ name: "Ana Lima", avatar_url: PIC_1 });
  });

  it("keeps only an https picture", () => {
    const { db, box } = setup();
    const { user } = upsertGoogleLogin(
      db,
      box,
      identity({ picture: "http://lh3.googleusercontent.com/a/plain" }),
      tokens,
      T0,
    );
    expect(profile(db, user.id)?.avatar_url).toBe("");
    upsertGoogleLogin(db, box, identity({ picture: "javascript:alert(1)" }), tokens, T0);
    expect(profile(db, user.id)?.avatar_url).toBe("");
  });

  it("booking pages show the owner's picture", async () => {
    const { db, box } = setup();
    const { user } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    run(
      db,
      "INSERT INTO booking_pages (user_id, slug, created_at, branding) VALUES (?, 'ana', ?, 'default')",
      user.id,
      T0,
    );
    const pub = publicBookingRoutes(
      db,
      {} as SyncService,
      "http://x",
      () => T0,
      () => undefined,
      {} as Mailer,
      7,
    );
    const page = (await (await pub.request("/pages/ana")).json()) as Record<string, unknown>;
    expect(page.picture).toBe(PIC_1);
  });
});

describe("Calendar settings from Google", () => {
  it("reads week start, time format and date format from the main account at each calendar list sync", async () => {
    const { db, box } = setup();
    const { user, accountId } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    expect(getSettings(db, user.id)).toMatchObject({
      weekStart: 1,
      timeFormat: "24h",
      dateFormat: "YMD",
    });
    await syncCalendarList(db, provider(db, box, accountId), accountId, user.id);
    // The Google week start is shown only; planning keeps its own (see the test below).
    expect(getSettings(db, user.id)).toMatchObject({
      weekStart: 1,
      googleWeekStart: 7,
      timeFormat: "12h",
      dateFormat: "MDY",
    });
    settings = () =>
      Response.json({
        items: [
          { id: "weekStart", value: "1" },
          { id: "format24HourTime", value: "true" },
          { id: "dateFieldOrder", value: "DMY" },
        ],
      });
    await syncCalendarList(db, provider(db, box, accountId), accountId, user.id);
    expect(getSettings(db, user.id)).toMatchObject({
      weekStart: 1,
      googleWeekStart: 1,
      timeFormat: "24h",
      dateFormat: "DMY",
    });
  });

  it("keeps the values and asks nothing when the grant lacks the settings scope, and still syncs the calendars", async () => {
    const { db, box } = setup();
    const { user, accountId } = upsertGoogleLogin(
      db,
      box,
      identity(),
      { ...tokens, scope: GOOGLE_SCOPES.filter((s) => !s.endsWith("settings.readonly")).join(" ") },
      T0,
    );
    await syncCalendarList(db, provider(db, box, accountId), accountId, user.id);
    expect(requests.filter((r) => r.endsWith("/users/me/settings"))).toEqual([]);
    expect(getSettings(db, user.id)).toMatchObject({ weekStart: 1, timeFormat: "24h" });
    expect(all(db, "SELECT provider_id FROM calendars")).toEqual([
      { provider_id: "ana@example.com" },
    ]);
  });

  it("logs a refused settings read once, not at every sync", async () => {
    const { db, box } = setup();
    const { user, accountId } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    settings = () =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Insufficient Permission",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
        { status: 403 },
      );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++)
        await syncCalendarList(db, provider(db, box, accountId), accountId, user.id);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("Calendar settings"))).toHaveLength(
        1,
      );
      expect(getSettings(db, user.id)).toMatchObject({ weekStart: 1, timeFormat: "24h" });
    } finally {
      log.mockRestore();
    }
  });

  it("does not read the settings of an added account that is not the main account", async () => {
    const { db, box } = setup();
    const { user } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    const added = upsertGoogleLogin(
      db,
      box,
      identity({ sub: "sub-work", email: "ana@work.example" }),
      tokens,
      T0,
      undefined,
      user.id,
    );
    await syncCalendarList(db, provider(db, box, added.accountId), added.accountId, user.id);
    expect(requests.filter((r) => r.endsWith("/users/me/settings"))).toEqual([]);
    expect(getSettings(db, user.id).weekStart).toBe(1);
  });

  it("a different Google week start changes no planning week start and no weekly meeting key", async () => {
    const { db, box } = setup();
    const { user, accountId } = upsertGoogleLogin(db, box, identity(), tokens, T0);
    run(db, "UPDATE users SET time_zone = 'UTC' WHERE id = ?", user.id);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", user);
      await next();
    });
    app.route(
      "/api",
      meetingRoutes(db, { request() {} } as unknown as SyncService, () => T0),
    );
    const res = await app.request("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Weekly sync",
        attendees: [{ email: "guest@example.com" }],
        frequency: { period: "weekly", everyWeeks: 2, idealDays: [2] },
        idealTime: "10:00",
        durationMinutes: 30,
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const keys = () =>
      plan(loadSnapshot(db, user.id, "UTC", getSettings(db, user.id), T0, 0).snapshot)
        .placements.filter((p) => p.kind === "meeting")
        .map((p) => [p.key, p.start]);
    // The first list sync makes the calendar the plan needs.
    await syncCalendarList(db, provider(db, box, accountId), accountId, user.id);
    run(db, "UPDATE users SET settings = '{}' WHERE id = ?", user.id);
    const before = keys();
    expect(before.length).toBeGreaterThan(0);
    // Google says Sunday (the default fake answer); planning keeps Monday.
    await syncCalendarList(db, provider(db, box, accountId), accountId, user.id);
    expect(getSettings(db, user.id)).toMatchObject({ weekStart: 1, googleWeekStart: 7 });
    expect(keys()).toEqual(before);
  });
});
