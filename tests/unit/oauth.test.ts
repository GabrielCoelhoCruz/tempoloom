// OAuth 2.1 for MCP clients (src/server/oauth.ts). The E2E suite runs the whole
// flow with the MCP SDK client and the consent page; these tests check the rules
// a client could break or exploit.
//
// Ways it can fail:
// 1. A client registers a redirect URI that runs script or leaves loopback over http.
// 2. A code is exchanged without the PKCE verifier, with another redirect URI, or twice.
// 3. A token outlives its grant (a used refresh token: see 9).
// 4. An expired access token still reads.
// 5. The consent request of an unknown client, or with a URI it did not register,
//    redirects anyway (an open redirect), or a request without PKCE gets a code.
// 6. A bad request of a registered client sends the browser to the client without a
//    click: anyone can register a client, so that is an open redirect.
// 7. The consent page does not say where the code goes, so a client named "Claude"
//    with an attacker's redirect URI looks like Claude.
// 8. A delegate or an API key mints a grant that outlives their access.
// 9. A stolen refresh token used after the real client keeps working; a deactivated
//    user's grant keeps refreshing.
// 10. Anonymous registration fills the disk: no rate limit, no cap, no clean-up.
// 11. One anonymous party stops all new connections: the cap refuses everyone, a
//     forged X-Forwarded-For dodges the limit, a proxy puts every user in one
//     bucket, an IPv6 host uses many addresses, or the limiter grows without end.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import { blockedForDelegate } from "../../src/server/delegation.ts";
import { setActive } from "../../src/server/directory.ts";
import {
  CLIENT_CAP,
  createLimiter,
  oauthConsentRoutes,
  oauthRoutes,
  oauthUser,
  REGISTRATIONS_PER_HOUR,
} from "../../src/server/oauth.ts";
import { membership } from "../../src/server/teams.ts";

const BASE = "https://cal.example.com";
const T0 = Date.parse("2026-10-19T08:00:00Z");
const REDIRECT = "http://127.0.0.1:33418/callback";
const VERIFIER = "a-verifier-of-enough-length-for-pkce-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function setup(trustedProxies: string[] = []) {
  const db = openDb(":memory:");
  let t = T0;
  const now = () => t;
  const user = ensureUser(db, "owner@example.com", "Owner", T0) as User;
  const app = new Hono<AppEnv>();
  app.route("/", oauthRoutes(db, BASE, now, trustedProxies));
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
  let ip = "203.0.113.1";
  let forwarded: string | undefined;
  const register = async (redirect_uris: string[]) =>
    app.request(
      "/oauth/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
        },
        body: JSON.stringify({ client_name: "Claude", redirect_uris }),
      },
      { incoming: { socket: { remoteAddress: ip } } },
    );
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
    fromIp: (address: string, xff?: string) => {
      ip = address;
      forwarded = xff;
    },
    getConsent: async (client_id: string, extra: Record<string, string> = {}) => {
      const res = await app.request(
        `/api/oauth/consent?${new URLSearchParams(query(client_id, extra))}`,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
      "com.example.app:/oauth/callback",
      "http://localhost:4000/cb",
    ])
      expect((await register([good])).status).toBe(201);
    // Only https, loopback http and private-use schemes in reverse-domain form (RFC 8252).
    for (const bad of [
      "ftp://files.example.com/cb",
      "ws://127.0.0.1:1/cb",
      "intent://x#Intent;end",
      "ldap://example.com",
      "myapp:/cb",
      "https://claude.ai/cb#frag",
    ])
      expect((await register([bad])).status, bad).toBe(400);
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

  it("shows a bad request of a registered client on the page with a link, never redirects without a click (6)", async () => {
    const s = setup();
    const id = await s.clientId();
    for (const extra of [
      { response_type: "token" },
      { code_challenge_method: "plain" },
      { scope: "admin" },
      { resource: "https://other.example/mcp" },
    ]) {
      const r = await s.getConsent(id, extra);
      expect(r.status).toBe(400);
      expect(r.body.redirect).toBeUndefined();
      expect(r.body.error).toBeTruthy();
      expect(r.body.host).toBe("127.0.0.1:33418");
      const back = new URL(String(r.body.returnTo));
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
      expect(back.searchParams.get("code")).toBeNull();
      expect(back.searchParams.get("error")).toBeTruthy();
    }
    // Unknown client or unregistered URI: no link at all.
    for (const r of [
      await s.getConsent("unknown"),
      await s.getConsent(id, { redirect_uri: "https://evil.example.com/cb" }),
    ]) {
      expect(r.status).toBe(400);
      expect(r.body.redirect).toBeUndefined();
      expect(r.body.returnTo).toBeUndefined();
    }
  });

  it("the consent request names where the code goes, the registration date, and that the name is unverified (7)", async () => {
    const s = setup();
    const id = await s.clientId();
    expect((await s.getConsent(id)).body).toMatchObject({
      client: "Claude",
      email: "owner@example.com",
      host: "127.0.0.1:33418",
      registeredAt: T0,
      unverified: true,
    });
    const app = (await (
      await s.register(["cursor://anysphere.cursor-mcp/oauth/callback"])
    ).json()) as { client_id: string };
    const r = await s.getConsent(app.client_id, {
      redirect_uri: "cursor://anysphere.cursor-mcp/oauth/callback",
    });
    expect(r.body.host).toBe("cursor://anysphere.cursor-mcp");
    // The Account page shows the host of each grant, too.
    await s.code(id);
    expect(await (await s.app.request("/api/oauth/grants")).json()).toMatchObject([
      { client: "Claude", host: "127.0.0.1:33418" },
    ]);
  });

  it("only the owner in a session of their own approves or revokes (8)", () => {
    for (const [method, path] of [
      ["POST", "/api/oauth/consent"],
      ["DELETE", "/api/oauth/grants/g1"],
    ] as const)
      expect(blockedForDelegate(method, path, "Owner"), path).toBeTruthy();
    expect(blockedForDelegate("GET", "/api/oauth/consent", "Owner")).toBeUndefined();
    expect(blockedForDelegate("GET", "/api/oauth/grants", "Owner")).toBeUndefined();
  });

  it("a deactivated user's grants and refresh tokens end (8)", async () => {
    const s = setup();
    const id = await s.clientId();
    const tokens = (await (await s.exchange(id, await s.code(id))).json()) as {
      refresh_token: string;
    };
    setActive(s.db, s.user.id, membership(s.db, s.user.id).team.id, false, T0);
    expect(all(s.db, "SELECT id FROM oauth_grants")).toEqual([]);
    expect(
      (
        await s.form({
          grant_type: "refresh_token",
          client_id: id,
          refresh_token: tokens.refresh_token,
        })
      ).status,
    ).toBe(400);
  });

  it("a deactivated user cannot refresh even if the grant row is left (8)", async () => {
    const s = setup();
    const id = await s.clientId();
    const tokens = (await (await s.exchange(id, await s.code(id))).json()) as {
      refresh_token: string;
    };
    run(s.db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, s.user.id);
    expect(
      (
        await s.form({
          grant_type: "refresh_token",
          client_id: id,
          refresh_token: tokens.refresh_token,
        })
      ).status,
    ).toBe(400);
  });

  it("a reused refresh token revokes the whole grant (9)", async () => {
    const s = setup();
    const id = await s.clientId();
    const first = (await (await s.exchange(id, await s.code(id))).json()) as {
      refresh_token: string;
    };
    const refresh = (token: string) =>
      s.form({ grant_type: "refresh_token", client_id: id, refresh_token: token });
    // The thief uses the token first and gets the new pair.
    const stolen = (await (await refresh(first.refresh_token)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(oauthUser(s.db, `Bearer ${stolen.access_token}`, T0)).toBeDefined();
    // The real client uses the old token again: the grant ends for both.
    const reuse = await refresh(first.refresh_token);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
    expect(oauthUser(s.db, `Bearer ${stolen.access_token}`, T0)).toBeUndefined();
    expect((await refresh(stolen.refresh_token)).status).toBe(400);
    expect(all(s.db, "SELECT id FROM oauth_grants")).toEqual([]);
  });

  it("limits registrations per address and in total, and deletes clients never authorized after a day (10)", async () => {
    const s = setup();
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++)
      expect((await s.register([REDIRECT])).status).toBe(201);
    expect((await s.register([REDIRECT])).status).toBe(429);
    // Another address is not limited; an hour later the first one is not either.
    s.fromIp("203.0.113.2");
    expect((await s.register([REDIRECT])).status).toBe(201);
    s.fromIp("203.0.113.1");
    s.tick(61 * 60_000);
    const kept = await s.clientId();
    await s.code(kept);
    // A day later, clients without a grant are gone; the one with a grant stays.
    s.tick(24 * 60 * 60_000);
    await s.clientId();
    const ids = all<{ id: string }>(s.db, "SELECT id FROM oauth_clients").map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(kept);
    // The cap counts clients without a grant on the whole server.
    for (let i = 0; i < CLIENT_CAP; i++)
      run(
        s.db,
        "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, 'x', '[]', ?)",
        `filler-${i}`,
        T0 + 25 * 60 * 60_000,
      );
    s.fromIp("203.0.113.9");
    expect((await s.register([REDIRECT])).status).toBe(201);
    expect(one(s.db, "SELECT 1 FROM oauth_clients WHERE id = ?", kept)).toBeTruthy();
  });

  it("at the cap, a new client replaces the oldest client without a grant; a client with a grant stays (11)", async () => {
    const s = setup();
    const kept = await s.clientId();
    await s.code(kept);
    for (let i = 0; i < CLIENT_CAP; i++)
      run(
        s.db,
        "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, 'x', '[]', ?)",
        `filler-${String(i).padStart(4, "0")}`,
        T0 - 60_000 + i,
      );
    // The granted client is the oldest of all; it is never evicted.
    run(s.db, "UPDATE oauth_clients SET created_at = ? WHERE id = ?", T0 - 120_000, kept);
    const res = await s.register([REDIRECT]);
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    expect(one(s.db, "SELECT 1 FROM oauth_clients WHERE id = ?", kept)).toBeTruthy();
    expect(one(s.db, "SELECT 1 FROM oauth_clients WHERE id = 'filler-0000'")).toBeUndefined();
    expect(one(s.db, "SELECT 1 FROM oauth_clients WHERE id = 'filler-0001'")).toBeTruthy();
    expect(one(s.db, "SELECT 1 FROM oauth_clients WHERE id = ?", client_id)).toBeTruthy();
    const unused = one<{ n: number }>(
      s.db,
      `SELECT COUNT(*) AS n FROM oauth_clients c
       WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)`,
    );
    expect(unused?.n).toBe(CLIENT_CAP);
  });

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy (11)", async () => {
    const s = setup();
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++) {
      s.fromIp("203.0.113.1", `198.51.100.${i}`);
      expect((await s.register([REDIRECT])).status).toBe(201);
    }
    s.fromIp("203.0.113.1", "198.51.100.200");
    expect((await s.register([REDIRECT])).status).toBe(429);
  });

  it("behind a trusted proxy, counts the client address of X-Forwarded-For (11)", async () => {
    const s = setup(["10.0.0.1"]);
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++) {
      // The client forged the left entry; the proxy appended the real address.
      s.fromIp("10.0.0.1", `198.51.100.${i}, 192.0.2.7`);
      expect((await s.register([REDIRECT])).status).toBe(201);
    }
    s.fromIp("10.0.0.1", "192.0.2.7");
    expect((await s.register([REDIRECT])).status).toBe(429);
    // Another user behind the same proxy has a bucket of their own.
    s.fromIp("10.0.0.1", "192.0.2.8");
    expect((await s.register([REDIRECT])).status).toBe(201);
  });

  it("counts IPv6 addresses by /64 (11)", async () => {
    const s = setup();
    for (let i = 0; i < REGISTRATIONS_PER_HOUR; i++) {
      s.fromIp(`2001:db8:1:2::${(i + 1).toString(16)}`);
      expect((await s.register([REDIRECT])).status).toBe(201);
    }
    s.fromIp("2001:db8:1:2:ffff:eeee:dddd:cccc");
    expect((await s.register([REDIRECT])).status).toBe(429);
    s.fromIp("2001:db8:1:3::1");
    expect((await s.register([REDIRECT])).status).toBe(201);
  });

  it("the limiter keeps a bounded number of buckets and drops expired ones first (11)", () => {
    const limiter = createLimiter({ perWindow: 1, windowMs: 1000, maxKeys: 3 });
    for (let i = 0; i < 10; i++) expect(limiter.hit(`k${i}`, 0)).toBe(true);
    expect(limiter.size()).toBe(3);
    expect(limiter.hit("k9", 1)).toBe(false);
    // After the window, an old key is counted again from zero.
    expect(limiter.hit("k9", 2000)).toBe(true);
  });
});
