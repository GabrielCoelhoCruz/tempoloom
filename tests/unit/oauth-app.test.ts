// OAuth for MCP clients inside the whole app (src/server/app.ts): the rules that
// depend on the session, the static client and Google sign-in.
//
// Ways it can fail:
// 1. An API key, which outlives any session, approves a consent and turns itself
//    into an OAuth grant that survives deleting the key.
// 2. Another site frames the consent page and tricks a click on "Allow access".
// 3. A signed-out user who signs in with Google lands on the planner, and the AI
//    tool waits for ever; or the return address sends the user to another site.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { createApiKey } from "../../src/server/api-keys.ts";
import { createApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { SecretBox } from "../../src/server/crypto.ts";
import { all, openDb } from "../../src/server/db.ts";
import type { Mailer } from "../../src/server/mail.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import type { WebhookWorker } from "../../src/server/webhooks.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const BASE = "http://localhost:8787";
const REDIRECT = "http://127.0.0.1:33418/callback";
const CHALLENGE = createHash("sha256").update("v".repeat(43)).digest("base64url");

afterEach(() => vi.unstubAllGlobals());

const idToken = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

function setup() {
  const key = randomBytes(32).toString("base64");
  const db = openDb(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "tl-oauth-app-"));
  const web = join(dataDir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Tempoloom</title>");
  const config = loadConfig({ SECRET_KEY: key, DATA_DIR: dataDir, BASE_URL: BASE, WEB_DIST: web });
  const app = createApp({
    db,
    config,
    box: new SecretBox(key),
    oauth: { clientId: "c", clientSecret: "s", redirectUri: `${BASE}/auth/google/callback` },
    sync: {
      onConnect: async () => {},
      onChange: () => {},
      request: () => {},
    } as unknown as SyncService,
    webhooks: {} as WebhookWorker,
    mailer: { configured: false, send: async () => {} } as Mailer,
    now: () => T0,
  });
  return { db, app };
}

describe("OAuth consent in the app", () => {
  it("refuses an API key on the consent and grant endpoints (1)", async () => {
    const { db, app } = setup();
    const user = ensureUser(db, "owner@example.com", "Owner", T0);
    const { secret } = createApiKey(db, user.id, { name: "k", expires: "never" }, T0);
    const reg = (await (
      await app.request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
      })
    ).json()) as { client_id: string };
    const res = await app.request("/api/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        response_type: "code",
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        allow: true,
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "session_required" });
    expect(all(db, "SELECT id FROM oauth_grants")).toEqual([]);
    const del = await app.request("/api/oauth/grants/x", {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(del.status).toBe(403);
  });

  it("the consent page may not be framed; other pages are unchanged (2)", async () => {
    const { app } = setup();
    const page = await app.request("/oauth/authorize?client_id=x");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    // The SPA HTML gets no wildcard CORS.
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    // The token and registration endpoints keep CORS for browser clients.
    for (const path of ["/oauth/token", "/oauth/register"]) {
      const pre = await app.request(path, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    }
    const planner = await app.request("/");
    expect(planner.headers.get("x-frame-options")).toBeNull();
  });

  it("Google sign-in returns to the pending authorization request, and only to it (3)", async () => {
    const { app } = setup();
    const pending = `/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1`;
    const signIn = async (returnTo: string) => {
      const start = await app.request(
        `/auth/google/start?return_to=${encodeURIComponent(returnTo)}`,
      );
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
      vi.stubGlobal("fetch", async () =>
        Response.json({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
          scope: "",
          token_type: "Bearer",
          id_token: idToken({
            sub: "sub-me",
            email: "me@example.com",
            name: "Me",
            email_verified: true,
          }),
        }),
      );
      const back = await app.request(`/auth/google/callback?state=${state}&code=abc`);
      expect(back.status).toBe(302);
      expect(back.headers.get("set-cookie")).toContain("tl_session=");
      return back.headers.get("location");
    };
    expect(await signIn(pending)).toBe(pending);
    for (const bad of ["https://evil.example/x", "//evil.example/oauth/authorize?x", "/account"])
      expect(await signIn(bad), bad).toBe("/");
  });
});
