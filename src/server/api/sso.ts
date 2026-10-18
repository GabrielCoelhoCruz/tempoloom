// Single sign-on through a team's OpenID Connect identity provider
// (docs/specs/admin-sso-provisioning.md rules 2-5, 9; edge cases 3-5), and
// connecting a CalDAV calendar after a sign-in that brought none.
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { isValidTimeZone } from "../../shared/time.ts";
import { ensureUser, upsertAccount } from "../accounts.ts";
import type { AppEnv } from "../app.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { isDeactivated } from "../directory.ts";
import { dropCoveredGrant } from "../grant.ts";
import { jsonBody } from "../http.ts";
import { CalDavProvider } from "../providers/caldav.ts";
import { ProviderError } from "../providers/types.ts";
import {
  authRequest,
  discover,
  exchangeCode,
  OidcError,
  signingKeys,
  tokenKeyId,
  verifyIdToken,
} from "../sso/oidc.ts";
import { type SsoMode, ssoForEmail } from "../sso/policy.ts";
import type { SyncService } from "../sync/service.ts";
import { hasFreeSeat, isCompanyDomain, membership, type Team } from "../teams.ts";

const STATE_TTL = 10 * 60_000;
const STATE_COOKIE = "tl_sso";
const hash = (t: string) => createHash("sha256").update(t).digest("base64url");
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface ConfigRow {
  team_id: string;
  issuer: string;
  client_id: string;
  client_secret: string;
  mode: SsoMode;
  domain_capture: number;
}

export interface SsoDeps {
  db: Db;
  box: SecretBox;
  baseUrl: string;
  seatLimit: number | undefined;
  now: () => number;
  startSession: (c: Context, userId: string) => void;
}

const redirectUri = (baseUrl: string) => new URL("/auth/sso/callback", baseUrl).toString();

const configOf = (db: Db, teamId: string) =>
  one<ConfigRow>(db, "SELECT * FROM sso_configs WHERE team_id = ?", teamId);

/** /auth/sso/*: start and finish a sign-in at the team's identity provider. */
export function ssoAuthRoutes(deps: SsoDeps): Hono {
  const { db, box, baseUrl, now } = deps;
  const r = new Hono();
  const secure = baseUrl.startsWith("https://");
  const fail = (c: Context, code: string) => c.redirect(`/?login_error=${code}`);
  const client = (cfg: ConfigRow) => ({
    issuer: cfg.issuer,
    clientId: cfg.client_id,
    clientSecret: box.open(cfg.client_secret),
    redirectUri: redirectUri(baseUrl),
  });

  r.get("/start", async (c) => {
    const email = (c.req.query("email") ?? "").trim().toLowerCase();
    const sso = /^[^@\s]+@[^@\s]+$/.test(email) ? ssoForEmail(db, email) : undefined;
    const cfg = sso && configOf(db, sso.teamId);
    if (!cfg) return fail(c, "sso_unknown_domain");
    let url: string;
    try {
      const req = authRequest(await discover(cfg.issuer, now()), client(cfg), email);
      run(db, "DELETE FROM sso_states WHERE created_at < ?", now() - STATE_TTL);
      run(
        db,
        "INSERT INTO sso_states (state, team_id, code_verifier, nonce, created_at) VALUES (?, ?, ?, ?, ?)",
        req.state,
        cfg.team_id,
        req.codeVerifier,
        req.nonce,
        now(),
      );
      // Binds the flow to this browser, so a link from someone else cannot finish it.
      setCookie(c, STATE_COOKIE, hash(req.state), {
        httpOnly: true,
        sameSite: "Lax",
        secure,
        path: "/auth/sso",
        maxAge: STATE_TTL / 1000,
      });
      url = req.url;
    } catch (err) {
      console.error("SSO start failed", err);
      return fail(c, "sso_failed");
    }
    return c.redirect(url);
  });

  r.get("/callback", async (c) => {
    const { state, code, error } = c.req.query();
    const bound = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/auth/sso" });
    const saved = state
      ? one<{ team_id: string; code_verifier: string; nonce: string; created_at: number }>(
          db,
          "SELECT * FROM sso_states WHERE state = ?",
          state,
        )
      : undefined;
    if (state) run(db, "DELETE FROM sso_states WHERE state = ?", state);
    if (error) return fail(c, "sso_failed");
    if (!saved || !code || saved.created_at < now() - STATE_TTL || bound !== hash(state ?? "")) {
      return fail(c, "invalid_state");
    }
    const cfg = configOf(db, saved.team_id);
    if (!cfg) return fail(c, "sso_failed");
    let claims: ReturnType<typeof verifyIdToken>;
    try {
      const d = await discover(cfg.issuer, now());
      const idToken = await exchangeCode(d, client(cfg), code, saved.code_verifier);
      claims = verifyIdToken(idToken, {
        issuer: cfg.issuer,
        clientId: cfg.client_id,
        nonce: saved.nonce,
        now: now(),
        keys: await signingKeys(d, tokenKeyId(idToken), now()),
      });
    } catch (err) {
      console.error("SSO sign-in failed", err instanceof OidcError ? err.code : err);
      return fail(c, "sso_failed");
    }
    // The identity provider vouches only for verified emails on the team's domains.
    if (!claims.emailVerified) return fail(c, "sso_unverified_email");
    if (ssoForEmail(db, claims.email)?.teamId !== cfg.team_id) return fail(c, "sso_domain");
    const existing = one<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", claims.email);
    let userId: string;
    if (existing) {
      if (isDeactivated(db, existing.id)) return fail(c, "deactivated");
      // Never sign in to an account outside the team: that would let any
      // identity provider take over accounts that signed up on their own.
      if (membership(db, existing.id).team.id !== cfg.team_id) return fail(c, "sso_other_team");
      userId = existing.id;
    } else {
      const team = one<Team>(db, "SELECT * FROM teams WHERE id = ?", cfg.team_id);
      if (!team || !hasFreeSeat(db, team, deps.seatLimit)) return fail(c, "no_seats");
      userId = ensureUser(db, claims.email, claims.name, now(), cfg.team_id).id;
    }
    deps.startSession(c, userId);
    return c.redirect("/");
  });

  return r;
}

const ssoBody = z.object({
  domains: z.array(z.string().trim().toLowerCase()).min(1).max(50),
  issuer: z.url({ protocol: /^https?$/ }),
  clientId: z.string().trim().min(1).max(500),
  /** Empty or missing keeps the saved secret. */
  clientSecret: z.string().max(2000).optional(),
  mode: z.enum(["sso_only", "sso_and_google"]),
  domainCapture: z.boolean(),
});

/** /api/team/sso: the team's SSO setup, for team admins. */
export function ssoAdminRoutes(deps: SsoDeps): Hono<AppEnv> {
  const { db, box, baseUrl, now } = deps;
  const r = new Hono<AppEnv>();
  const adminTeam = (c: Context<AppEnv>) => {
    const m = membership(db, c.get("user").id);
    if (m.role !== "admin") {
      throw new HTTPException(403, {
        res: Response.json({ error: "forbidden" }, { status: 403 }),
      });
    }
    return m.team.id;
  };

  r.get("/team/sso", (c) => {
    const teamId = adminTeam(c);
    const cfg = configOf(db, teamId);
    return c.json({
      domains: all<{ domain: string }>(
        db,
        "SELECT domain FROM sso_domains WHERE team_id = ? ORDER BY domain",
        teamId,
      ).map((d) => d.domain),
      issuer: cfg?.issuer ?? "",
      clientId: cfg?.client_id ?? "",
      hasSecret: Boolean(cfg),
      mode: cfg?.mode ?? "sso_only",
      domainCapture: cfg?.domain_capture === 1,
      redirectUri: redirectUri(baseUrl),
    });
  });

  r.put("/team/sso", async (c) => {
    const teamId = adminTeam(c);
    const body = await jsonBody(c, ssoBody);
    const domains = [...new Set(body.domains.filter(Boolean))];
    for (const domain of domains) {
      if (!DOMAIN.test(domain)) return c.json({ error: "invalid_domain", domain }, 400);
      if (!isCompanyDomain(domain)) return c.json({ error: "public_domain", domain }, 409);
      if (one(db, "SELECT 1 FROM sso_domains WHERE domain = ? AND team_id <> ?", domain, teamId)) {
        return c.json({ error: "domain_taken", domain }, 409);
      }
    }
    if (domains.length === 0) return c.json({ error: "invalid_domain", domain: "" }, 400);
    const saved = configOf(db, teamId);
    const secret = body.clientSecret ? box.seal(body.clientSecret) : saved?.client_secret;
    if (!secret) return c.json({ error: "secret_required" }, 400);
    try {
      await discover(body.issuer, now());
    } catch (err) {
      return c.json({ error: err instanceof OidcError ? err.code : "provider_unreachable" }, 400);
    }
    tx(db, () => {
      run(
        db,
        `INSERT INTO sso_configs (team_id, issuer, client_id, client_secret, mode, domain_capture, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (team_id) DO UPDATE SET issuer = excluded.issuer, client_id = excluded.client_id,
           client_secret = excluded.client_secret, mode = excluded.mode,
           domain_capture = excluded.domain_capture, updated_at = excluded.updated_at`,
        teamId,
        body.issuer,
        body.clientId,
        secret,
        body.mode,
        body.domainCapture ? 1 : 0,
        now(),
      );
      run(db, "DELETE FROM sso_domains WHERE team_id = ?", teamId);
      for (const d of domains) {
        run(db, "INSERT INTO sso_domains (domain, team_id) VALUES (?, ?)", d, teamId);
      }
    });
    return c.json({ ok: true });
  });

  r.delete("/team/sso", (c) => {
    const teamId = adminTeam(c);
    tx(db, () => {
      run(db, "DELETE FROM sso_domains WHERE team_id = ?", teamId);
      run(db, "DELETE FROM sso_configs WHERE team_id = ?", teamId);
    });
    return c.body(null, 204);
  });

  return r;
}

const connectBody = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
});

/** /api/accounts/caldav: connects a CalDAV calendar to the signed-in user. */
export function connectRoutes(deps: {
  db: Db;
  box: SecretBox;
  sync: SyncService;
  now: () => number;
}): Hono<AppEnv> {
  const { db, box, sync, now } = deps;
  const r = new Hono<AppEnv>();
  r.post("/accounts/caldav", async (c) => {
    const user = c.get("user");
    const { timeZone, ...body } = await jsonBody(c, connectBody);
    try {
      const calendars = await new CalDavProvider(
        { ...body, email: user.email },
        "UTC",
      ).listCalendars();
      if (calendars.length === 0) return c.json({ error: "no_calendars" }, 400);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") {
        return c.json({ error: "invalid_credentials" }, 401);
      }
      return c.json({ error: "server_unreachable" }, 502);
    }
    const externalId = `${new URL(body.serverUrl).href}|${body.username}`;
    const owner = one<{ user_id: string }>(
      db,
      "SELECT user_id FROM accounts WHERE provider = 'caldav' AND external_id = ?",
      externalId,
    );
    if (owner && owner.user_id !== user.id) return c.json({ error: "account_in_use" }, 409);
    // SSO brings no time zone: the first own calendar takes the browser's, as CalDAV sign-in does.
    const first = !one(
      db,
      "SELECT 1 FROM accounts WHERE user_id = ? AND grant_team_id IS NULL",
      user.id,
    );
    if (first && timeZone)
      run(db, "UPDATE users SET time_zone = ? WHERE id = ?", timeZone, user.id);
    const accountId = upsertAccount(
      db,
      box,
      {
        userId: user.id,
        provider: "caldav",
        externalId,
        email: user.email,
        serverUrl: body.serverUrl,
        credentials: { username: body.username, password: body.password },
      },
      now(),
    );
    await sync.onConnect(user.id, accountId);
    dropCoveredGrant(db, user.id);
    return c.json({ ok: true });
  });
  return r;
}
