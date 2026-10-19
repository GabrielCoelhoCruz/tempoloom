// Reconnect of a disconnected Google account (accounts-login-emails-permissions.md
// rule 15) through Google sign-in, against an in-memory database and a fake
// Google token endpoint.
//
// Ways it can fail:
// 1. Google does not get the account's email as a hint, so the user may pick
//    another Google identity.
// 2. A sign-in with another Google identity is taken as the reconnect: the
//    account stays disconnected and another account is added or signed in.
// 3. A sign-in with the same identity does not connect the account again.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, ensureUser, upsertGoogleLogin } from "../../src/server/accounts.ts";
import { createApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import type { Mailer } from "../../src/server/mail.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import type { WebhookWorker } from "../../src/server/webhooks.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const ME = { sub: "sub-me", email: "me@example.com", name: "Me", emailVerified: true };

afterEach(() => vi.unstubAllGlobals());

const idToken = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

function setup() {
  const key = randomBytes(32).toString("base64");
  const db = openDb(":memory:");
  const box = new SecretBox(key);
  const user = ensureUser(db, ME.email, ME.name, T0);
  const { accountId } = upsertGoogleLogin(
    db,
    box,
    ME,
    { accessToken: "a", refreshToken: "r", expiresAt: T0, scope: "" },
    T0,
    undefined,
    user.id,
  );
  run(db, "UPDATE accounts SET status = 'reauth_required' WHERE id = ?", accountId);
  const config = loadConfig({
    SECRET_KEY: key,
    DATA_DIR: mkdtempSync(join(tmpdir(), "tl-reconnect-")),
    BASE_URL: "http://localhost:8787",
  });
  const app = createApp({
    db,
    config,
    box,
    oauth: {
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost:8787/auth/google/callback",
    },
    sync: { onConnect: async () => {}, onChange: () => {} } as unknown as SyncService,
    webhooks: {} as WebhookWorker,
    mailer: { configured: false, send: async () => {} } as Mailer,
    now: () => T0,
  });
  const cookie = `tl_session=${createSession(db, user.id, T0)}`;
  const status = () =>
    one<{ status: string }>(db, "SELECT status FROM accounts WHERE id = ?", accountId)?.status;
  /** Starts the reconnect and returns Google's URL. */
  const start = async () => {
    const res = await app.request(`/auth/google/start?reconnect=${accountId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "");
  };
  /** Comes back from Google signed in as `who`. */
  const callback = async (state: string, who: { sub: string; email: string }) => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "",
        token_type: "Bearer",
        id_token: idToken({ ...who, name: "Someone", email_verified: true }),
      }),
    );
    return app.request(`/auth/google/callback?state=${state}&code=abc`, { headers: { cookie } });
  };
  return { db, status, start, callback };
}

describe("Google reconnect", () => {
  it("asks Google for the account's identity and connects it again", async () => {
    const s = setup();
    const google = await s.start();
    expect(google.searchParams.get("login_hint")).toBe(ME.email);
    const res = await s.callback(google.searchParams.get("state") ?? "", ME);
    expect(res.status).toBe(302);
    expect(s.status()).toBe("ok");
  });

  it("refuses another Google identity", async () => {
    const s = setup();
    const google = await s.start();
    const res = await s.callback(google.searchParams.get("state") ?? "", {
      sub: "sub-other",
      email: "other@example.com",
    });
    expect(res.headers.get("location")).toBe("/account?reconnect_error=other_identity");
    expect(s.status()).toBe("reauth_required");
    expect(all(s.db, "SELECT external_id FROM accounts")).toEqual([{ external_id: ME.sub }]);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
