import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SecretBox } from "./crypto.ts";
import { all, type Db, one, run, tx } from "./db.ts";
import {
  type GoogleIdentity,
  identityFromIdToken,
  type OAuthClient,
  OAuthError,
  refreshAccessToken,
  type TokenSet,
} from "./google/oauth.ts";
import { type ServiceAccountKey, serviceAccountToken } from "./google/service-account.ts";
import { applyTeamDefaults } from "./team-defaults.ts";
import { createOwnTeam } from "./teams.ts";

export interface User {
  id: string;
  email: string;
  name: string;
  time_zone: string;
}

export type Provider = "google" | "google_service" | "caldav" | "ics";

export interface AccountRow {
  id: string;
  user_id: string;
  provider: Provider;
  external_id: string;
  email: string;
  server_url: string | null;
  credentials: string;
  access_token: string | null;
  access_expires_at: number;
  status: "ok" | "reauth_required";
  /** Set when the account was attached through a team's calendar grant. */
  grant_team_id: string | null;
}

const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

export function createSession(db: Db, userId: string, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  run(
    db,
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    hashToken(token),
    userId,
    now,
    now + SESSION_DAYS * 86_400_000,
  );
  run(
    db,
    "UPDATE users SET first_sign_in_at = ? WHERE id = ? AND first_sign_in_at IS NULL",
    now,
    userId,
  );
  return token;
}

export function userForSession(db: Db, token: string, now = Date.now()): User | undefined {
  return one<User>(
    db,
    `SELECT u.id, u.email, u.name, u.time_zone FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.deactivated_at IS NULL`,
    hashToken(token),
    now,
  );
}

export function deleteSession(db: Db, token: string): void {
  run(db, "DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

/** One-time sign-in link for an operator-created account (CLI). */
export function createLoginLink(db: Db, userId: string, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  run(
    db,
    "INSERT INTO login_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    hashToken(token),
    userId,
    now + LINK_MINUTES * 60_000,
  );
  return token;
}

export function consumeLoginLink(db: Db, token: string, now = Date.now()): string | undefined {
  return tx(db, () => {
    const row = one<{ user_id: string; expires_at: number }>(
      db,
      "SELECT user_id, expires_at FROM login_links WHERE token_hash = ?",
      hashToken(token),
    );
    run(db, "DELETE FROM login_links WHERE token_hash = ?", hashToken(token));
    return row && row.expires_at > now ? row.user_id : undefined;
  });
}

const WEEKDAYS_9_TO_5 = JSON.stringify({
  1: [[540, 1020]],
  2: [[540, 1020]],
  3: [[540, 1020]],
  4: [[540, 1020]],
  5: [[540, 1020]],
});
const EVENINGS = JSON.stringify(
  Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, [[1080, 1320]]])),
);

/**
 * Finds a user by email or creates one with the built-in hours sets. A new user
 * gets a team of their own, or joins `teamId` as a member (provisioning).
 */
export function ensureUser(
  db: Db,
  email: string,
  name: string,
  now = Date.now(),
  teamId?: string,
): User {
  return tx(db, () => {
    const existing = one<User>(
      db,
      "SELECT id, email, name, time_zone FROM users WHERE email = ?",
      email.toLowerCase(),
    );
    if (existing) return existing;
    const id = randomUUID();
    run(
      db,
      "INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)",
      id,
      email.toLowerCase(),
      name,
      now,
    );
    for (const [kind, label, weekly] of [
      ["work", "Work hours", WEEKDAYS_9_TO_5],
      ["meeting", "Meeting hours", WEEKDAYS_9_TO_5],
      ["personal", "Personal hours", EVENINGS],
    ] as const) {
      run(
        db,
        "INSERT INTO hours_sets (id, user_id, kind, name, weekly, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        randomUUID(),
        id,
        kind,
        label,
        weekly,
        now,
      );
    }
    if (teamId) {
      run(
        db,
        "INSERT INTO team_members (user_id, team_id, role, joined_at) VALUES (?, ?, 'member', ?)",
        id,
        teamId,
        now,
      );
      applyTeamDefaults(db, teamId, id, now);
    } else createOwnTeam(db, { id, name, email: email.toLowerCase() }, now);
    return { id, email: email.toLowerCase(), name, time_zone: "UTC" };
  });
}

export interface AccountInput {
  userId: string;
  provider: Provider;
  externalId: string;
  email: string;
  serverUrl?: string;
  /** Plain JSON; sealed before it is stored. */
  credentials: Record<string, string>;
  accessToken?: string;
  accessExpiresAt?: number;
  scope?: string;
  /** The main email of the user; by default when the user has none yet. Kept on update. */
  isMain?: boolean;
}

/** True when the user has a main email (accounts-login-emails-permissions.md rule 10). */
export const hasMainAccount = (db: Db, userId: string) =>
  Boolean(one(db, "SELECT 1 FROM accounts WHERE user_id = ? AND is_main = 1", userId));

/** Creates or updates the user's account with this provider identity. */
export function upsertAccount(db: Db, box: SecretBox, a: AccountInput, now = Date.now()): string {
  const existing = one<{ id: string }>(
    db,
    "SELECT id FROM accounts WHERE user_id = ? AND provider = ? AND external_id = ?",
    a.userId,
    a.provider,
    a.externalId,
  );
  const id = existing?.id ?? randomUUID();
  const isMain = a.provider !== "ics" && (a.isMain ?? !hasMainAccount(db, a.userId));
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, server_url, credentials,
       access_token, access_expires_at, scope, status, created_at, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       email = excluded.email, server_url = excluded.server_url, credentials = excluded.credentials,
       access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
       scope = excluded.scope, status = 'ok'`,
    id,
    a.userId,
    a.provider,
    a.externalId,
    a.email,
    a.serverUrl ?? null,
    box.seal(JSON.stringify(a.credentials)),
    a.accessToken ? box.seal(a.accessToken) : null,
    a.accessExpiresAt ?? 0,
    a.scope ?? "",
    now,
    isMain ? 1 : 0,
  );
  return id;
}

/** Which Tempoloom account a sign-in with a calendar account opens. */
export type LoginTarget =
  | { userId: string }
  /** Secondary email of several accounts and main of none (rule 3.3). */
  | { several: true }
  /** The typed email is the main email of an account that this calendar account is not in. */
  | { taken: true }
  /** Unknown: sign up (rule 3.4). */
  | null;

/**
 * Resolves a sign-in (accounts-login-emails-permissions.md rule 3): the
 * account where this identity is the main email, then a person who exists
 * before a first calendar (provisioning, single sign-on), then the one account
 * that holds it as a secondary email. A CalDAV server does not prove the typed
 * email, so the email alone never opens an account that has calendars.
 */
export function loginTarget(
  db: Db,
  provider: Provider,
  externalId: string,
  email: string,
): LoginTarget {
  const holders = all<{ user_id: string; is_main: number }>(
    db,
    `SELECT user_id, is_main FROM accounts
     WHERE provider = ? AND external_id = ? AND grant_team_id IS NULL ORDER BY is_main DESC, created_at`,
    provider,
    externalId,
  );
  const main = holders.find((h) => h.is_main === 1);
  if (main) return { userId: main.user_id };
  const byEmail = one<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", email);
  const ownAccounts = (userId: string) =>
    one(
      db,
      "SELECT 1 FROM accounts WHERE user_id = ? AND grant_team_id IS NULL AND provider <> 'ics'",
      userId,
    );
  if (byEmail && !ownAccounts(byEmail.id)) return { userId: byEmail.id };
  const [only, second] = holders;
  if (only && !second) return { userId: only.user_id };
  if (second) return { several: true };
  return byEmail ? { taken: true } : null;
}

/**
 * Creates or updates the user and Google account after a successful login.
 * Google returns a refresh token only on first consent, so an existing one is kept.
 * A new user joins `teamId` when given (SSO domain capture). With `forUserId`
 * (the operator CLI), the account goes to that user, and an account that
 * another user holds is an error.
 */
/**
 * Name and picture follow the user's main Google account at each sign-in and
 * each token refresh, so at least daily (settings-profile.md PRF-2, PRF-3). A
 * picture the user hides in Google is not in the token: no picture (PRF-5).
 */
export function applyGoogleIdentity(db: Db, accountId: string, identity: GoogleIdentity): void {
  run(
    db,
    `UPDATE users SET name = ?, avatar_url = ?
     WHERE id = (SELECT user_id FROM accounts WHERE id = ? AND provider = 'google' AND is_main = 1)`,
    identity.name,
    identity.picture ?? "",
    accountId,
  );
}

export function upsertGoogleLogin(
  db: Db,
  box: SecretBox,
  identity: GoogleIdentity,
  tokens: TokenSet,
  now = Date.now(),
  teamId?: string,
  forUserId?: string,
): { user: User; accountId: string } {
  return tx(db, () => {
    const existing = one<AccountRow>(
      db,
      "SELECT * FROM accounts WHERE provider = 'google' AND external_id = ? ORDER BY is_main DESC, created_at LIMIT 1",
      identity.sub,
    );
    if (existing && forUserId && existing.user_id !== forUserId) {
      throw new Error(`Google account ${identity.email} belongs to another user`);
    }
    const userId = existing?.user_id ?? forUserId;
    const user = userId
      ? one<User>(db, "SELECT id, email, name, time_zone FROM users WHERE id = ?", userId)
      : ensureUser(db, identity.email, identity.name, now, teamId);
    if (!user) throw new Error(`No user ${userId}`);
    const previous = existing
      ? (JSON.parse(box.open(existing.credentials)) as { refreshToken?: string })
      : {};
    const refreshToken = tokens.refreshToken ?? previous.refreshToken;
    if (!refreshToken) {
      throw new OAuthError("no_refresh_token", "Google did not return a refresh token");
    }
    const accountId = upsertAccount(
      db,
      box,
      {
        userId: user.id,
        provider: "google",
        externalId: identity.sub,
        email: identity.email,
        credentials: { refreshToken },
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        scope: tokens.scope,
      },
      now,
    );
    applyGoogleIdentity(db, accountId, identity);
    return { user, accountId };
  });
}

export function account(db: Db, accountId: string): AccountRow {
  const row = one<AccountRow>(db, "SELECT * FROM accounts WHERE id = ?", accountId);
  if (!row) throw new Error(`Unknown account ${accountId}`);
  return row;
}

export function credentialsOf(box: SecretBox, row: AccountRow): Record<string, string> {
  return JSON.parse(box.open(row.credentials)) as Record<string, string>;
}

function saveAccessToken(db: Db, box: SecretBox, id: string, t: TokenSet): void {
  run(
    db,
    "UPDATE accounts SET access_token = ?, access_expires_at = ? WHERE id = ?",
    box.seal(t.accessToken),
    t.expiresAt,
    id,
  );
}

/** A valid access token for a Google account, refreshed when needed. */
export async function googleAccessToken(
  db: Db,
  box: SecretBox,
  accountId: string,
  opts: {
    oauth?: OAuthClient | undefined;
    serviceKey?: ServiceAccountKey | undefined;
    now?: number;
    /** Skip the cached access token: Google refused it. */
    fresh?: boolean;
  },
): Promise<string> {
  const now = opts.now ?? Date.now();
  const row = account(db, accountId);
  if (row.status !== "ok") throw new OAuthError("reauth_required", "Account needs a new login");
  if (!opts.fresh && row.access_token && row.access_expires_at > now)
    return box.open(row.access_token);
  let tokens: TokenSet;
  if (row.provider === "google_service") {
    if (!opts.serviceKey) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");
    tokens = await serviceAccountToken(opts.serviceKey, { now });
  } else {
    if (!opts.oauth) throw new Error("Google OAuth is not configured");
    const { refreshToken } = credentialsOf(box, row);
    if (!refreshToken) throw new OAuthError("no_refresh_token", "Account has no refresh token");
    try {
      tokens = await refreshAccessToken(opts.oauth, refreshToken, now);
    } catch (err) {
      if (err instanceof OAuthError && err.code === "invalid_grant") {
        // Only the refresh token that Google refused: a reconnect saved meanwhile stays.
        run(
          db,
          "UPDATE accounts SET status = 'reauth_required' WHERE id = ? AND credentials IS ?",
          accountId,
          row.credentials,
        );
      }
      throw err;
    }
  }
  saveAccessToken(db, box, accountId, tokens);
  if (tokens.idToken) applyGoogleIdentity(db, accountId, identityFromIdToken(tokens.idToken));
  return tokens.accessToken;
}
