// Operator connection of a Google account without a browser sign-in
// (src/server/cli.ts). The token and the calendar are checked with Google
// before anything is written; the account and its pinned calendar are then
// written in one transaction, so a sync tick never sees one without the other.
import { randomUUID } from "node:crypto";
import { ensureUser, upsertAccount, upsertGoogleLogin } from "../accounts.ts";
import type { SecretBox } from "../crypto.ts";
import { type Db, run, tx } from "../db.ts";
import { GoogleProvider } from "../providers/google.ts";
import type { ProviderCalendar } from "../providers/types.ts";
import { GoogleCalendarApi } from "./calendar.ts";
import { identityFromIdToken, type OAuthClient, OAuthError, refreshAccessToken } from "./oauth.ts";
import { type ServiceAccountKey, serviceAccountToken } from "./service-account.ts";

export interface ConnectTarget {
  /** The Tempoloom user that gets the account. */
  email: string;
  name?: string | undefined;
  /** The calendar to plan on; it must be a writable calendar in the account's list. */
  calendar?: string | undefined;
}

export interface Connected {
  userId: string;
  accountId: string;
}

/** Connects a Google user from a refresh token got by a consent done elsewhere. */
export async function connectGoogleOauth(
  db: Db,
  box: SecretBox,
  client: Omit<OAuthClient, "redirectUri"> | undefined,
  refreshToken: string | undefined,
  target: ConnectTarget,
): Promise<Connected> {
  if (!client) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN is not set");
  const tokens = await refreshAccessToken({ ...client, redirectUri: "" }, refreshToken).catch(
    (err: unknown) => {
      const code = err instanceof OAuthError ? err.code : String(err);
      throw new Error(`Google refused the refresh token (${code})`);
    },
  );
  if (!tokens.idToken) throw new Error("Google returned no ID token; the grant lacks openid");
  const identity = identityFromIdToken(tokens.idToken);
  const pin = target.calendar && (await listedCalendar(tokens.accessToken, target.calendar));
  return tx(db, () => {
    const user = ensureUser(db, target.email, target.name ?? target.email);
    const { accountId } = upsertGoogleLogin(
      db,
      box,
      identity,
      { ...tokens, refreshToken },
      Date.now(),
      undefined,
      user.id,
    );
    if (pin) pinCalendar(db, accountId, pin);
    return { userId: user.id, accountId };
  });
}

/** Connects the configured service account; it reads only calendars shared with it. */
export async function connectGoogleServiceAccount(
  db: Db,
  box: SecretBox,
  key: ServiceAccountKey,
  target: ConnectTarget,
): Promise<Connected> {
  const pin =
    target.calendar &&
    (await listedCalendar((await serviceAccountToken(key)).accessToken, target.calendar));
  return tx(db, () => {
    const user = ensureUser(db, target.email, target.name ?? target.email);
    const accountId = upsertAccount(db, box, {
      userId: user.id,
      provider: "google_service",
      externalId: key.client_email,
      email: key.client_email,
      credentials: {},
    });
    if (pin) pinCalendar(db, accountId, pin);
    return { userId: user.id, accountId };
  });
}

/** The calendar as the sync lists it; an unknown or read-only calendar is an error. */
async function listedCalendar(accessToken: string, id: string): Promise<ProviderCalendar> {
  const api = new GoogleCalendarApi({ getAccessToken: async () => accessToken });
  const found = (await new GoogleProvider(api, "UTC").listCalendars()).find((c) => c.id === id);
  if (!found) throw new Error(`Calendar ${id} is not in the account's calendar list`);
  if (!found.writable) throw new Error(`Calendar ${id} is read-only for this account`);
  return found;
}

/**
 * Makes `c` the account's only primary calendar, the one the planner writes
 * to, and the only one checked for availability. The sync keeps a primary
 * that is still listed and adds new calendars unchecked.
 */
function pinCalendar(db: Db, accountId: string, c: ProviderCalendar): void {
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, time_zone, writable, is_primary, color, check_availability)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1)
     ON CONFLICT (account_id, provider_id) DO UPDATE SET is_primary = 1, check_availability = 1`,
    randomUUID(),
    accountId,
    c.id,
    c.name,
    c.timeZone,
    c.color,
  );
  run(
    db,
    "UPDATE calendars SET is_primary = 0, check_availability = 0 WHERE account_id = ? AND provider_id <> ?",
    accountId,
    c.id,
  );
}
