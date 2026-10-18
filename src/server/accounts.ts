import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SecretBox } from "./crypto.ts";
import { type Db, one, run, tx } from "./db.ts";
import {
  type GoogleIdentity,
  type OAuthClient,
  OAuthError,
  refreshAccessToken,
  type TokenSet,
} from "./google/oauth.ts";

export interface User {
  id: string;
  email: string;
  name: string;
  time_zone: string;
}

export interface GoogleAccount {
  id: string;
  user_id: string;
  google_sub: string;
  email: string;
  refresh_token: string;
  access_token: string | null;
  access_expires_at: number;
  status: "ok" | "reauth_required";
}

const SESSION_DAYS = 30;

const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

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
  return token;
}

export function userForSession(db: Db, token: string, now = Date.now()): User | undefined {
  return one<User>(
    db,
    `SELECT u.id, u.email, u.name, u.time_zone FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hashToken(token),
    now,
  );
}

export function deleteSession(db: Db, token: string): void {
  run(db, "DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

/**
 * Creates or updates the user and Google account after a successful login.
 * Google returns a refresh token only on first consent, so an existing one is kept.
 */
export function upsertGoogleLogin(
  db: Db,
  box: SecretBox,
  identity: GoogleIdentity,
  tokens: TokenSet,
  now = Date.now(),
): { user: User; accountId: string } {
  return tx(db, () => {
    const existing = one<GoogleAccount>(
      db,
      "SELECT * FROM google_accounts WHERE google_sub = ?",
      identity.sub,
    );
    let userId = existing?.user_id;
    if (!userId) {
      userId =
        one<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", identity.email)?.id ??
        randomUUID();
      run(
        db,
        `INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        userId,
        identity.email,
        identity.name,
        now,
      );
    }
    const refresh = tokens.refreshToken ? box.seal(tokens.refreshToken) : existing?.refresh_token;
    if (!refresh) {
      throw new OAuthError("no_refresh_token", "Google did not return a refresh token");
    }
    const accountId = existing?.id ?? randomUUID();
    run(
      db,
      `INSERT INTO google_accounts
         (id, user_id, google_sub, email, refresh_token, access_token, access_expires_at, scope, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)
       ON CONFLICT (id) DO UPDATE SET
         email = excluded.email, refresh_token = excluded.refresh_token,
         access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
         scope = excluded.scope, status = 'ok'`,
      accountId,
      userId,
      identity.sub,
      identity.email,
      refresh,
      box.seal(tokens.accessToken),
      tokens.expiresAt,
      tokens.scope,
      now,
    );
    const user = one<User>(
      db,
      "SELECT id, email, name, time_zone FROM users WHERE id = ?",
      userId,
    ) as User;
    return { user, accountId };
  });
}

/** Returns a valid access token, refreshing it when needed. */
export async function accessTokenFor(
  db: Db,
  box: SecretBox,
  client: OAuthClient,
  accountId: string,
  now = Date.now(),
): Promise<string> {
  const acct = one<GoogleAccount>(db, "SELECT * FROM google_accounts WHERE id = ?", accountId);
  if (!acct) throw new Error(`Unknown account ${accountId}`);
  if (acct.status !== "ok") throw new OAuthError("reauth_required", "Account needs a new login");
  if (acct.access_token && acct.access_expires_at > now) return box.open(acct.access_token);
  let tokens: TokenSet;
  try {
    tokens = await refreshAccessToken(client, box.open(acct.refresh_token), now);
  } catch (err) {
    if (err instanceof OAuthError && err.code === "invalid_grant") {
      run(db, "UPDATE google_accounts SET status = 'reauth_required' WHERE id = ?", accountId);
    }
    throw err;
  }
  run(
    db,
    "UPDATE google_accounts SET access_token = ?, access_expires_at = ? WHERE id = ?",
    box.seal(tokens.accessToken),
    tokens.expiresAt,
    accountId,
  );
  return tokens.accessToken;
}
