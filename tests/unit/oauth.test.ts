// OAuth 2.1 for MCP clients (src/server/oauth.ts). The E2E suite runs the whole
// flow with the MCP SDK client and the consent page; these tests check the rules
// a client could break or exploit.
//
// Ways it can fail:
// 1. A client registers a redirect URI that runs script or leaves loopback over http.
// 2. A code is exchanged without the PKCE verifier, with another redirect URI, or twice.
// 3. A used refresh token still works (no rotation), or a token outlives its grant.
// 4. An expired access token still reads.
// 5. The consent request of an unknown client, or with a URI it did not register,
//    redirects anyway (an open redirect), or a request without PKCE gets a code.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { openDb } from "../../src/server/db.ts";
import { oauthConsentRoutes, oauthRoutes, oauthUser } from "../../src/server/oauth.ts";

const BASE = "https://cal.example.com";
const T0 = Date.parse("2026-10-19T08:00:00Z");
const REDIRECT = "http://127.0.0.1:33418/callback";
const VERIFIER = "a-verifier-of-enough-length-for-pkce-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function setup() {
  const db = openDb(":memory:");
  let t = T0;
  const now = () => t;
  const user = ensureUser(db, "owner@example.com", "Owner", T0) as User;
  const app = new Hono<AppEnv>();
  app.route("/", oauthRoutes(db, BASE, now));
  app.use("/api/*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/api", oauthConsentRoutes(db, BASE, now));
  const form = (body: Record<string, string>) =>
    app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  const register = async (redirect_uris: string[]) =>
    app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris }),
    });
  const clientId = async () =>
    ((await (await register([REDIRECT])).json()) as { client_id: string }).client_id;
  const query = (client_id: string, extra: Record<string, string> = {}) => ({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "s1",
    ...extra,
  });
  const consent = async (client_id: string, extra: Record<string, string> = {}) => {
    const res = await app.request("/api/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...query(client_id, extra), allow: true }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { redirect?: string; error?: string },
    };
  };
  const code = async (client_id: string) =>
    new URL((await consent(client_id)).body.redirect ?? "").searchParams.get("code") ?? "";
  const exchange = (client_id: string, c: string, extra: Record<string, string> = {}) =>
    form({
      grant_type: "authorization_code",
      client_id,
      code: c,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      ...extra,
    });
  return {
    db,
    app,
    user,
    register,
    clientId,
    consent,
    code,
    exchange,
    form,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe("OAuth for MCP clients", () => {
  it("publishes the resource and authorization server metadata", async () => {
    const { app } = setup();
    expect(
      await (await app.request("/.well-known/oauth-protected-resource/mcp")).json(),
    ).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });
    expect(
      await (await app.request("/.well-known/oauth-authorization-server")).json(),
    ).toMatchObject({
      issuer: BASE,
      code_challenge_methods_supported: ["S256"],
      registration_endpoint: `${BASE}/oauth/register`,
    });
  });

  it("refuses redirect URIs that run script or leave loopback over http (1)", async () => {
    const { register } = setup();
    for (const bad of [
      "javascript:alert(1)",
      "http://evil.example.com/cb",
      "data:text/html,x",
      "not a url",
    ])
      expect((await register([bad])).status).toBe(400);
    for (const good of [
      REDIRECT,
      "https://claude.ai/api/mcp/auth_callback",
      "cursor://anysphere.cursor-mcp/oauth/callback",
    ])
      expect((await register([good])).status).toBe(201);
  });

  it("needs the PKCE verifier and the same redirect URI, and a code works once (2)", async () => {
    const s = setup();
    const id = await s.clientId();
    let c = await s.code(id);
    expect(
      (await s.exchange(id, c, { code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier" }))
        .status,
    ).toBe(400);
    // The failed exchange used up the code.
    expect((await s.exchange(id, c)).status).toBe(400);
    c = await s.code(id);
    expect((await s.exchange(id, c, { redirect_uri: "http://127.0.0.1:1/other" })).status).toBe(
      400,
    );
    c = await s.code(id);
    const ok = await s.exchange(id, c);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ token_type: "Bearer", scope: "mcp" });
    expect((await s.exchange(id, c)).status).toBe(400);
    // Another client cannot use this client's code.
    const other = await s.clientId();
    const c2 = await s.code(id);
    expect((await s.exchange(other, c2)).status).toBe(400);
  });

  it("rotates refresh tokens, and revoking the grant stops every token (3)", async () => {
    const s = setup();
    const id = await s.clientId();
    const first = (await (await s.exchange(id, await s.code(id))).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const refresh = (token: string) =>
      s.form({ grant_type: "refresh_token", client_id: id, refresh_token: token });
    const second = (await (await refresh(first.refresh_token)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(second.access_token).toBeTruthy();
    expect((await refresh(first.refresh_token)).status).toBe(400);
    expect(oauthUser(s.db, `Bearer ${second.access_token}`, T0)?.client).toBe("Claude");
    const [grant] = (await (await s.app.request("/api/oauth/grants")).json()) as { id: string }[];
    expect(
      (await s.app.request(`/api/oauth/grants/${grant?.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(oauthUser(s.db, `Bearer ${second.access_token}`, T0)).toBeUndefined();
    expect((await refresh(second.refresh_token)).status).toBe(400);
  });

  it("an access token expires after an hour (4)", async () => {
    const s = setup();
    const id = await s.clientId();
    const { access_token } = (await (await s.exchange(id, await s.code(id))).json()) as {
      access_token: string;
    };
    expect(oauthUser(s.db, `Bearer ${access_token}`, T0 + 59 * 60_000)).toBeDefined();
    expect(oauthUser(s.db, `Bearer ${access_token}`, T0 + 61 * 60_000)).toBeUndefined();
  });

  it("shows unsafe requests on the page instead of redirecting, and needs PKCE (5)", async () => {
    const s = setup();
    const id = await s.clientId();
    expect((await s.consent("unknown")).status).toBe(400);
    expect((await s.consent(id, { redirect_uri: "https://evil.example.com/cb" })).status).toBe(400);
    const noPkce = await s.consent(id, { code_challenge_method: "plain" });
    const back = new URL(noPkce.body.redirect ?? "");
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("state")).toBe("s1");
  });
});
