// Operator connection of a Google account (src/server/cli.ts connect-google-oauth,
// src/server/google/connect.ts), against an in-memory database and a fake
// Google token endpoint and calendar list.
//
// Ways it can fail:
// 1. The command writes an account when the OAuth client is not configured or
//    Google refuses the refresh token; the error appears only at the next sync.
// 2. The account is keyed by something else than the Google subject, so a later
//    browser sign-in with the same Google account makes a second account row.
// 3. The account email comes from the environment, not from Google's ID token.
// 4. A --calendar that the account does not list (or cannot write) is accepted;
//    the next sync then drops it and writes to the account's real primary.
// 5. Other calendars of the account stay primary or checked for availability,
//    also when a sync listed them before the pin, or lists them after it.
// 6. The Google account of another Tempoloom user is moved to this one.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser, upsertGoogleLogin } from "../../src/server/accounts.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { all, type Db, openDb } from "../../src/server/db.ts";
import { connectGoogleOauth } from "../../src/server/google/connect.ts";
import type { CalendarProvider } from "../../src/server/providers/types.ts";
import { syncCalendarList } from "../../src/server/sync/pull.ts";

const CLIENT = { clientId: "client-1", clientSecret: "secret-1" };
const GOOD_TOKEN = "refresh-good";
const SUB = "google-sub-42";
const GOOGLE_EMAIL = "tester@example.com";
const USER_EMAIL = "e2e@tempoloom.test";
const TEST_CAL = "test123@group.calendar.google.com";
const LISTED = [
  { id: GOOGLE_EMAIL, summary: GOOGLE_EMAIL, primary: true, accessRole: "owner" },
  { id: TEST_CAL, summary: "[tl-test] tempoloom-e2e", accessRole: "owner" },
  { id: "ro@group.calendar.google.com", summary: "Read only", accessRole: "reader" },
];

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = `${b64({ alg: "RS256" })}.${b64({ sub: SUB, email: GOOGLE_EMAIL, email_verified: true })}.sig`;

let requests: string[];

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init?.body));
      const ok =
        body.get("refresh_token") === GOOD_TOKEN &&
        body.get("client_id") === CLIENT.clientId &&
        body.get("client_secret") === CLIENT.clientSecret;
      return ok
        ? Response.json({
            access_token: "access-1",
            expires_in: 3600,
            scope: "",
            id_token: idToken,
          })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      return Response.json({ items: LISTED });
    }
    return new Response("not found", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const db = openDb(":memory:");
  const box = new SecretBox(randomBytes(32).toString("base64"));
  return { db, box };
}

const accounts = (db: Db) =>
  all<{ id: string; user_id: string; external_id: string; email: string; credentials: string }>(
    db,
    "SELECT id, user_id, external_id, email, credentials FROM accounts",
  );
const calendars = (db: Db) =>
  all<{ provider_id: string; is_primary: number; check_availability: number }>(
    db,
    "SELECT provider_id, is_primary, check_availability FROM calendars ORDER BY provider_id",
  );

/** The account's calendars as the sync lists them (src/server/providers/google.ts). */
const listedProvider = {
  listCalendars: async () =>
    LISTED.map((c) => ({
      id: c.id,
      name: c.summary,
      primary: c.primary === true,
      writable: c.accessRole === "owner",
      timeZone: null,
      color: null,
    })),
} as unknown as CalendarProvider;

describe("connect-google-oauth", () => {
  it("fails before any write when the OAuth client is not configured", async () => {
    const { db, box } = setup();
    await expect(
      connectGoogleOauth(db, box, undefined, GOOD_TOKEN, { email: USER_EMAIL }),
    ).rejects.toThrow("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
    expect(requests).toEqual([]);
    expect(accounts(db)).toEqual([]);
  });

  it("fails before any write when Google refuses the refresh token", async () => {
    const { db, box } = setup();
    await expect(
      connectGoogleOauth(db, box, CLIENT, "refresh-revoked", { email: USER_EMAIL }),
    ).rejects.toThrow("Google refused the refresh token (invalid_grant)");
    expect(accounts(db)).toEqual([]);
    await expect(
      connectGoogleOauth(db, box, { ...CLIENT, clientSecret: "other" }, GOOD_TOKEN, {
        email: USER_EMAIL,
      }),
    ).rejects.toThrow("invalid_grant");
    expect(accounts(db)).toEqual([]);
  });

  it("keys the account by the Google subject and takes the email from the ID token", async () => {
    const { db, box } = setup();
    const c = await connectGoogleOauth(db, box, CLIENT, GOOD_TOKEN, { email: USER_EMAIL });
    const [row, ...more] = accounts(db);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ id: c.accountId, user_id: c.userId, external_id: SUB });
    expect(row?.email).toBe(GOOGLE_EMAIL);
    expect(JSON.parse(box.open(row?.credentials ?? ""))).toEqual({ refreshToken: GOOD_TOKEN });
    expect(ensureUser(db, USER_EMAIL, USER_EMAIL).id).toBe(c.userId);

    // A later browser sign-in with the same Google account updates the same row.
    const login = upsertGoogleLogin(
      db,
      box,
      { sub: SUB, email: GOOGLE_EMAIL, name: "T", emailVerified: true },
      { accessToken: "a2", expiresAt: Date.now() + 3_600_000, scope: "" },
    );
    expect(login.accountId).toBe(c.accountId);
    expect(accounts(db)).toHaveLength(1);
  });

  it("refuses a Google account that another user holds", async () => {
    const { db, box } = setup();
    await connectGoogleOauth(db, box, CLIENT, GOOD_TOKEN, { email: "other@tempoloom.test" });
    await expect(
      connectGoogleOauth(db, box, CLIENT, GOOD_TOKEN, { email: USER_EMAIL }),
    ).rejects.toThrow("belongs to another user");
    expect(accounts(db)).toHaveLength(1);
  });
});

describe("--calendar", () => {
  it("rejects a calendar that the account does not list, before any write", async () => {
    const { db, box } = setup();
    for (const calendar of ["missing@group.calendar.google.com", "ro@group.calendar.google.com"]) {
      await expect(
        connectGoogleOauth(db, box, CLIENT, GOOD_TOKEN, { email: USER_EMAIL, calendar }),
      ).rejects.toThrow(calendar);
    }
    expect(accounts(db)).toEqual([]);
    expect(calendars(db)).toEqual([]);
  });

  it("pins the calendar as the only primary and checked calendar, through later syncs", async () => {
    const { db, box } = setup();
    const c = await connectGoogleOauth(db, box, CLIENT, GOOD_TOKEN, {
      email: USER_EMAIL,
      calendar: TEST_CAL,
    });
    const pinned = [
      { provider_id: "ro@group.calendar.google.com", is_primary: 0, check_availability: 0 },
      { provider_id: TEST_CAL, is_primary: 1, check_availability: 1 },
      { provider_id: GOOGLE_EMAIL, is_primary: 0, check_availability: 0 },
    ];
    expect(calendars(db)).toEqual([pinned[1]]);
    await syncCalendarList(db, listedProvider, c.accountId, c.userId);
    expect(calendars(db)).toEqual(pinned);
  });

  it("unchecks calendars that a sync listed before the pin", async () => {
    const { db, box } = setup();
    const c = await connectGoogleOauth(db, box, CLIENT, GOOD_TOKEN, { email: USER_EMAIL });
    await syncCalendarList(db, listedProvider, c.accountId, c.userId);
    expect(calendars(db)).toContainEqual({
      provider_id: GOOGLE_EMAIL,
      is_primary: 1,
      check_availability: 1,
    });
    await connectGoogleOauth(db, box, CLIENT, GOOD_TOKEN, {
      email: USER_EMAIL,
      calendar: TEST_CAL,
    });
    await syncCalendarList(db, listedProvider, c.accountId, c.userId);
    expect(calendars(db)).toEqual([
      { provider_id: "ro@group.calendar.google.com", is_primary: 0, check_availability: 0 },
      { provider_id: TEST_CAL, is_primary: 1, check_availability: 1 },
      { provider_id: GOOGLE_EMAIL, is_primary: 0, check_availability: 0 },
    ]);
  });
});

describe("the CLI command", () => {
  it("exits with the configuration error and writes nothing without an OAuth client", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tempoloom-cli-"));
    const env = {
      PATH: process.env.PATH ?? "",
      DATA_DIR: dataDir,
      SECRET_KEY: randomBytes(32).toString("base64"),
      GOOGLE_REFRESH_TOKEN: GOOD_TOKEN,
    };
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        ["src/server/cli.ts", "connect-google-oauth", "--email", USER_EMAIL],
        { cwd: join(import.meta.dirname, "../.."), env, encoding: "utf8", stdio: "pipe" },
      );
    } catch (err) {
      stderr = String((err as { stderr: string }).stderr);
    }
    expect(stderr).toContain("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
    const db = openDb(join(dataDir, "tempoloom.db"));
    expect(accounts(db)).toEqual([]);
    db.close();
  });
});
