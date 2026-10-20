// OAuth 2.1 for MCP clients (integrations-ai-tools.md "Authorization"; the MCP
// authorization spec): protected resource and authorization server metadata,
// dynamic client registration, the authorization code flow with PKCE (S256)
// and a consent page in the web app, rotating refresh tokens, and a grant per
// client and user that the user can revoke on the Account page (rules 6, 8).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { hashToken, type User } from "./accounts.ts";
import type { AppEnv } from "./app.ts";
import { all, type Db, one, run, tx } from "./db.ts";
import { jsonBody, notFound } from "./http.ts";

export const SCOPE = "mcp";
const CODE_TTL = 10 * 60_000;
const ACCESS_TTL = 60 * 60_000;
const REFRESH_TTL = 30 * 86_400_000;

const newToken = () => randomBytes(32).toString("base64url");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** The URL of the MCP server, which is the OAuth resource. */
export const resourceOf = (baseUrl: string) => new URL("/mcp", baseUrl).toString();
/** Where a client finds the authorization server of the MCP server (RFC 9728). */
export const resourceMetadataUrl = (baseUrl: string) =>
  new URL("/.well-known/oauth-protected-resource/mcp", baseUrl).toString();

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, http on loopback only, or an app's own scheme; never a script or a file. */
function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return !["javascript:", "data:", "file:", "blob:", "vbscript:", "about:"].includes(u.protocol);
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
}

const clientOf = (db: Db, id: string) =>
  one<ClientRow>(db, "SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?", id);

/** The request of the consent page: the query of /oauth/authorize. */
export const authorizeQuery = z.object({
  response_type: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});
type AuthorizeQuery = z.infer<typeof authorizeQuery>;

type Checked =
  | { ok: true; client: ClientRow; challenge: string }
  /** No safe place to send the error to: the page shows it. */
  | { ok: false; show: string }
  /** The client gets the error at its redirect URI. */
  | { ok: false; error: string; description: string };

function check(db: Db, baseUrl: string, q: AuthorizeQuery): Checked {
  const client = clientOf(db, q.client_id);
  if (!client) return { ok: false, show: "This AI tool is not registered with Tempoloom." };
  if (!(JSON.parse(client.redirect_uris) as string[]).includes(q.redirect_uri))
    return { ok: false, show: "The AI tool sent a return address it did not register." };
  if (q.response_type !== "code")
    return { ok: false, error: "unsupported_response_type", description: "Use response_type=code" };
  if (!q.code_challenge || q.code_challenge_method !== "S256")
    return { ok: false, error: "invalid_request", description: "PKCE with S256 is required" };
  if (q.scope?.split(" ").some((s) => s && s !== SCOPE))
    return { ok: false, error: "invalid_scope", description: `The only scope is ${SCOPE}` };
  if (q.resource && q.resource !== resourceOf(baseUrl))
    return { ok: false, error: "invalid_target", description: "Unknown resource" };
  return { ok: true, client, challenge: q.code_challenge };
}

function back(q: AuthorizeQuery, params: Record<string, string>): string {
  const u = new URL(q.redirect_uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (q.state !== undefined) u.searchParams.set("state", q.state);
  return u.toString();
}

/** Issues a new access token and refresh token of a grant. */
function issue(db: Db, grantId: string, now: number) {
  const access = newToken();
  const refresh = newToken();
  run(
    db,
    "INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, 'access', ?), (?, ?, 'refresh', ?)",
    hashToken(access),
    grantId,
    now + ACCESS_TTL,
    hashToken(refresh),
    grantId,
    now + REFRESH_TTL,
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL / 1000,
    refresh_token: refresh,
    scope: SCOPE,
  };
}

/** The user and client name of an OAuth access token in `Authorization: Bearer`, or undefined. */
export function oauthUser(
  db: Db,
  header: string | undefined,
  now: number,
): { user: User; client: string } | undefined {
  const token = /^Bearer (\S+)$/.exec(header ?? "")?.[1];
  if (!token) return undefined;
  const row = one<User & { grant_id: string; client: string }>(
    db,
    `SELECT u.id, u.email, u.name, u.time_zone, g.id AS grant_id, c.name AS client
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
     JOIN oauth_clients c ON c.id = g.client_id JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND u.deactivated_at IS NULL`,
    hashToken(token),
    now,
  );
  if (!row) return undefined;
  run(db, "UPDATE oauth_grants SET last_used_at = ? WHERE id = ?", now, row.grant_id);
  const { grant_id: _, client, ...user } = row;
  return { user, client };
}

const registration = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
});

/** The public OAuth endpoints: metadata, registration and the token endpoint. */
export function oauthRoutes(db: Db, baseUrl: string, now: () => number): Hono {
  const issuer = new URL(baseUrl).origin;
  const r = new Hono();
  // Clients may run in a browser: the public endpoints allow any origin, without credentials.
  r.use("/.well-known/*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
  });
  r.use("/oauth/*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version");
      return c.body(null, 204);
    }
    await next();
    c.header("Access-Control-Allow-Origin", "*");
  });

  const resource = () => ({
    resource: resourceOf(baseUrl),
    authorization_servers: [issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Tempoloom",
  });
  r.get("/.well-known/oauth-protected-resource", (c) => c.json(resource()));
  r.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(resource()));
  r.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  // Dynamic client registration (RFC 7591): public clients only, no secret.
  r.post("/oauth/register", async (c) => {
    const parsed = registration.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "invalid_client_metadata", error_description: "Bad metadata" }, 400);
    const m = parsed.data;
    const bad = m.redirect_uris.find((u) => !redirectAllowed(u));
    if (bad)
      return c.json(
        { error: "invalid_redirect_uri", error_description: `Not allowed: ${bad}` },
        400,
      );
    const id = randomUUID();
    const name = m.client_name || "AI tool";
    const at = now();
    run(
      db,
      "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
      id,
      name,
      JSON.stringify(m.redirect_uris),
      at,
    );
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(at / 1000),
        client_name: name,
        redirect_uris: m.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      },
      201,
    );
  });

  r.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const f = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
    const fail = (error: string, description: string, status: 400 | 401 = 400) => {
      c.header("Cache-Control", "no-store");
      return c.json({ error, error_description: description }, status);
    };
    c.header("Cache-Control", "no-store");
    const client = clientOf(db, f("client_id"));
    if (!client) return fail("invalid_client", "Unknown client", 401);
    if (f("resource") && f("resource") !== resourceOf(baseUrl))
      return fail("invalid_target", "Unknown resource");
    const t = now();

    if (f("grant_type") === "authorization_code") {
      const code = one<{ grant_id: string; redirect_uri: string; code_challenge: string }>(
        db,
        `SELECT k.grant_id, k.redirect_uri, k.code_challenge FROM oauth_codes k
         JOIN oauth_grants g ON g.id = k.grant_id
         WHERE k.code_hash = ? AND k.expires_at > ? AND g.client_id = ?`,
        hashToken(f("code")),
        t,
        client.id,
      );
      // A code works once, also when the exchange fails.
      run(db, "DELETE FROM oauth_codes WHERE code_hash = ?", hashToken(f("code")));
      if (!code) return fail("invalid_grant", "The code is unknown, used or expired");
      if (code.redirect_uri !== f("redirect_uri"))
        return fail("invalid_grant", "redirect_uri does not match");
      if (s256(f("code_verifier")) !== code.code_challenge)
        return fail("invalid_grant", "The PKCE verifier does not match");
      return c.json(tx(db, () => issue(db, code.grant_id, t)));
    }

    if (f("grant_type") === "refresh_token") {
      const hash = hashToken(f("refresh_token"));
      const row = one<{ grant_id: string }>(
        db,
        `SELECT t.grant_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.token_hash = ? AND t.kind = 'refresh' AND t.expires_at > ? AND g.client_id = ?`,
        hash,
        t,
        client.id,
      );
      if (!row) return fail("invalid_grant", "The refresh token is unknown, revoked or expired");
      // Rotation: the used refresh token stops working.
      return c.json(
        tx(db, () => {
          run(db, "DELETE FROM oauth_tokens WHERE token_hash = ?", hash);
          run(
            db,
            "DELETE FROM oauth_tokens WHERE grant_id = ? AND expires_at <= ?",
            row.grant_id,
            t,
          );
          return issue(db, row.grant_id, t);
        }),
      );
    }
    return fail("unsupported_grant_type", "Use authorization_code or refresh_token");
  });

  return r;
}

/** The consent page's API and the grant list of the Account page (signed-in user). */
export function oauthConsentRoutes(db: Db, baseUrl: string, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/oauth/consent", (c) => {
    const q = authorizeQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "The request of the AI tool is incomplete." }, 400);
    const v = check(db, baseUrl, q.data);
    if (!v.ok)
      return "show" in v
        ? c.json({ error: v.show }, 400)
        : c.json({ redirect: back(q.data, { error: v.error, error_description: v.description }) });
    const user = c.get("user");
    return c.json({ client: v.client.name, email: user.email, scope: SCOPE });
  });

  r.post("/oauth/consent", async (c) => {
    const body = await jsonBody(c, authorizeQuery.extend({ allow: z.boolean() }));
    const v = check(db, baseUrl, body);
    if (!v.ok)
      return "show" in v
        ? c.json({ error: v.show }, 400)
        : c.json({ redirect: back(body, { error: v.error, error_description: v.description }) });
    if (!body.allow)
      return c.json({
        redirect: back(body, { error: "access_denied", error_description: "The user declined" }),
      });
    const user = c.get("user");
    const t = now();
    const code = newToken();
    tx(db, () => {
      run(
        db,
        `INSERT INTO oauth_grants (id, user_id, client_id, scope, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, client_id) DO NOTHING`,
        randomUUID(),
        user.id,
        v.client.id,
        SCOPE,
        t,
      );
      const grant = one<{ id: string }>(
        db,
        "SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ?",
        user.id,
        v.client.id,
      );
      run(
        db,
        "INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
        hashToken(code),
        grant?.id ?? "",
        body.redirect_uri,
        v.challenge,
        t + CODE_TTL,
      );
    });
    return c.json({ redirect: back(body, { code }) });
  });

  r.get("/oauth/grants", (c) =>
    c.json(
      all<{
        id: string;
        client: string;
        scope: string;
        createdAt: number;
        lastUsedAt: number | null;
      }>(
        db,
        `SELECT g.id, c.name AS client, g.scope, g.created_at AS createdAt, g.last_used_at AS lastUsedAt
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
         WHERE g.user_id = ? ORDER BY g.created_at, g.id`,
        c.get("user").id,
      ),
    ),
  );

  /** Rule 6: revokes one client's access; its tokens stop at once. Calendar access stays. */
  r.delete("/oauth/grants/:id", (c) => {
    const { changes } = db
      .prepare("DELETE FROM oauth_grants WHERE id = ? AND user_id = ?")
      .run(c.req.param("id"), c.get("user").id);
    if (!changes) notFound("grant");
    return c.body(null, 204);
  });

  return r;
}
