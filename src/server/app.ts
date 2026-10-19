import { readdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { Context } from "hono";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { isValidTimeZone } from "../shared/time.ts";
import {
  consumeLoginLink,
  createSession,
  deleteSession,
  ensureUser,
  loginTarget,
  type User,
  upsertAccount,
  upsertGoogleLogin,
} from "./accounts.ts";
import { accountRoutes } from "./api/account.ts";
import { analyticsRoutes } from "./api/analytics.ts";
import { automationRoutes } from "./api/automations.ts";
import { bookingRoutes, publicBookingRoutes } from "./api/booking.ts";
import { bookingShareRoutes } from "./api/booking-share.ts";
import { bookingViewerRoutes } from "./api/booking-viewer.ts";
import { brandingRoutes, publicBrandingRoutes } from "./api/branding.ts";
import { bufferFilterRoutes } from "./api/buffer-filters.ts";
import { calendarRoutes } from "./api/calendars.ts";
import { delegationGuard, delegationRoutes } from "./api/delegation.ts";
import { eventActionRoutes } from "./api/event-actions.ts";
import { focusExtraRoutes } from "./api/focus-extras.ts";
import { helpRoutes } from "./api/help.ts";
import { hoursExtraRoutes } from "./api/hours-extra.ts";
import { insightRoutes } from "./api/insights.ts";
import { itemRoutes } from "./api/items.ts";
import { meetingCheckRoutes } from "./api/meeting-checks.ts";
import { meetingRoutes } from "./api/meetings.ts";
import { mirrorRoutes } from "./api/mirrors.ts";
import { nowRoutes } from "./api/now.ts";
import { oooRoutes } from "./api/ooo.ts";
import { plannerRoutes } from "./api/planner.ts";
import { policyRoutes } from "./api/policies.ts";
import { previewRoutes } from "./api/preview.ts";
import { provisioningRoutes } from "./api/provisioning.ts";
import { scimRoutes } from "./api/scim.ts";
import { settingsRoutes } from "./api/settings.ts";
import { ssoAdminRoutes, ssoAuthRoutes } from "./api/sso.ts";
import { statsRoutes } from "./api/stats.ts";
import { taskSearchRoutes } from "./api/task-searches.ts";
import { taskTimeRoutes } from "./api/task-time.ts";
import { publicInviteRoutes, teamRoutes } from "./api/team.ts";
import { teamDefaultRoutes } from "./api/team-defaults.ts";
import { travelRoutes } from "./api/travel.ts";
import { webhookRoutes } from "./api/webhooks.ts";
import { apiKeyUser } from "./api-keys.ts";
import type { Config } from "./config.ts";
import type { SecretBox } from "./crypto.ts";
import { all, type Db, one, openDb, run } from "./db.ts";
import { ownersOf, sessionIdentity } from "./delegation.ts";
import { isDeactivated } from "./directory.ts";
import { embedRoutes } from "./embed.ts";
import {
  buildAuthRequest,
  exchangeCode,
  identityFromIdToken,
  type OAuthClient,
} from "./google/oauth.ts";
import { dropCoveredGrant } from "./grant.ts";
import { jsonBody } from "./http.ts";
import { createLiveHub } from "./live.ts";
import type { Mailer } from "./mail.ts";
import { mcpRoutes } from "./mcp.ts";
import { createPreview } from "./preview.ts";
import { CalDavProvider } from "./providers/caldav.ts";
import { ProviderError } from "./providers/types.ts";
import { getSettings } from "./settings.ts";
import { otherSignIn } from "./sso/policy.ts";
import type { SyncService } from "./sync/service.ts";
import { enqueueBookingEvent, type WebhookWorker } from "./webhooks.ts";

export interface AppDeps {
  db: Db;
  config: Config;
  box: SecretBox;
  oauth: OAuthClient | undefined;
  sync: SyncService;
  webhooks: WebhookWorker;
  mailer: Mailer;
  now?: () => number;
}

/**
 * `user` owns the data a request works on. In an acting session (delegated
 * access) `actor` is the delegate behind it. `session` is unset for API keys.
 */
export type AppEnv = { Variables: { user: User; actor?: User; session?: string } };

const SESSION_COOKIE = "tl_session";
const STATE_TTL = 10 * 60_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** The sync service of a dry-run app: every call does nothing. */
const DRY_SYNC = new Proxy({}, { get: () => () => undefined }) as SyncService;

const caldavLogin = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
  email: z.email().optional(),
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
  /** Sign up with an email that several accounts hold as a secondary email (rule 3.3). */
  newAccount: z.boolean().optional(),
});

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { db, config, box, sync } = deps;
  const now = deps.now ?? Date.now;
  const secure = config.BASE_URL.startsWith("https://");
  const origin = new URL(config.BASE_URL).origin;
  const app = new Hono<AppEnv>();
  app.use(compress());

  const startSession = (c: Context, userId: string) =>
    setCookie(c, SESSION_COOKIE, createSession(db, userId, now()), {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      path: "/",
      maxAge: 30 * 86_400,
    });

  app.use("/api/*", csrf({ origin }));
  app.use("/auth/*", csrf({ origin }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/auth/methods", (c) => c.json({ google: Boolean(deps.oauth), caldav: true }));

  app.get("/auth/google/start", (c) => {
    if (!deps.oauth) return c.text("Google sign-in is not configured on this server.", 503);
    const req = buildAuthRequest(deps.oauth, c.req.query("login_hint"));
    run(db, "DELETE FROM oauth_states WHERE created_at < ?", now() - STATE_TTL);
    run(
      db,
      "INSERT INTO oauth_states (state, code_verifier, created_at) VALUES (?, ?, ?)",
      req.state,
      req.codeVerifier,
      now(),
    );
    return c.redirect(req.url);
  });

  app.get("/auth/google/callback", async (c) => {
    if (!deps.oauth) return c.text("Google sign-in is not configured on this server.", 503);
    const { state, code, error } = c.req.query();
    if (error) return c.redirect(`/?login_error=${encodeURIComponent(error)}`);
    const saved = state
      ? one<{ code_verifier: string; created_at: number }>(
          db,
          "SELECT code_verifier, created_at FROM oauth_states WHERE state = ?",
          state,
        )
      : undefined;
    if (state) run(db, "DELETE FROM oauth_states WHERE state = ?", state);
    if (!saved || !code || saved.created_at < now() - STATE_TTL) {
      return c.redirect("/?login_error=invalid_state");
    }
    try {
      const tokens = await exchangeCode(deps.oauth, code, saved.code_verifier, now());
      if (!tokens.idToken) return c.redirect("/?login_error=no_identity");
      const identity = identityFromIdToken(tokens.idToken);
      // Domains that a team registered for SSO (admin-sso-provisioning.md rules 3, 4, 9).
      const rule = otherSignIn(db, identity.email, config.TEAM_SEAT_LIMIT);
      if ("refuse" in rule) return c.redirect(`/?login_error=${rule.refuse}`);
      const { user, accountId } = upsertGoogleLogin(db, box, identity, tokens, now(), rule.teamId);
      if (isDeactivated(db, user.id)) return c.redirect("/?login_error=deactivated");
      startSession(c, user.id);
      void sync.onConnect(user.id, accountId);
      return c.redirect("/");
    } catch (err) {
      console.error("Google sign-in failed", err);
      return c.redirect("/?login_error=google_failed");
    }
  });

  /** Signs in with CalDAV credentials. The server checks them before it saves anything. */
  app.post("/auth/caldav", async (c) => {
    const body = await jsonBody(c, caldavLogin);
    const email = (body.email ?? (body.username.includes("@") ? body.username : "")).toLowerCase();
    if (!email) return c.json({ error: "email_required" }, 400);
    const probe = new CalDavProvider(
      { serverUrl: body.serverUrl, username: body.username, password: body.password, email },
      "UTC",
    );
    try {
      const calendars = await probe.listCalendars();
      if (calendars.length === 0) return c.json({ error: "no_calendars" }, 400);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") {
        return c.json({ error: "invalid_credentials" }, 401);
      }
      return c.json({ error: "server_unreachable" }, 502);
    }
    if (one(db, "SELECT 1 FROM users WHERE email = ? AND deactivated_at IS NOT NULL", email))
      return c.json({ error: "deactivated" }, 403);
    // Domains that a team registered for SSO (admin-sso-provisioning.md rules 3, 4, 9).
    const rule = otherSignIn(db, email, config.TEAM_SEAT_LIMIT);
    if ("refuse" in rule) return c.json({ error: rule.refuse }, 403);
    // Any email of an account signs in to it (accounts-login-emails-permissions.md rules 2-4).
    const externalId = `${new URL(body.serverUrl).href}|${body.username}`;
    const target = loginTarget(db, "caldav", externalId, email);
    if (target && "taken" in target) return c.json({ error: "email_taken" }, 409);
    if (target && "several" in target && !body.newAccount)
      return c.json({ error: "several_accounts" }, 409);
    if (target && "userId" in target && isDeactivated(db, target.userId))
      return c.json({ error: "deactivated" }, 403);
    if (target && "several" in target && one(db, "SELECT 1 FROM users WHERE email = ?", email))
      return c.json({ error: "email_taken" }, 409);
    // A provisioned person (SCIM) exists before their first sign-in.
    const user =
      target && "userId" in target
        ? (one<User>(
            db,
            "SELECT id, email, name, time_zone FROM users WHERE id = ?",
            target.userId,
          ) as User)
        : ensureUser(db, email, body.username, now(), rule.teamId);
    const isNew = !one(
      db,
      "SELECT 1 FROM users WHERE id = ? AND first_sign_in_at IS NOT NULL",
      user.id,
    );
    // CalDAV has no account time zone; take the browser's on first sign-in.
    if (isNew && body.timeZone)
      run(db, "UPDATE users SET time_zone = ? WHERE id = ?", body.timeZone, user.id);
    const accountId = upsertAccount(
      db,
      box,
      {
        userId: user.id,
        provider: "caldav",
        externalId,
        email,
        serverUrl: body.serverUrl,
        credentials: { username: body.username, password: body.password },
      },
      now(),
    );
    startSession(c, user.id);
    await sync.onConnect(user.id, accountId);
    dropCoveredGrant(db, user.id);
    return c.json({ ok: true });
  });

  app.get("/auth/link/:token", (c) => {
    const userId = consumeLoginLink(db, c.req.param("token"), now());
    if (!userId) return c.redirect("/?login_error=link_expired");
    if (isDeactivated(db, userId)) return c.redirect("/?login_error=deactivated");
    startSession(c, userId);
    return c.redirect("/");
  });

  app.post("/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  // Public booking pages' API: no session.
  const webhookDeps = {
    db,
    box,
    allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
    retryBaseMs: config.WEBHOOK_RETRY_BASE_MS,
    now,
  };
  app.route(
    "/pub",
    publicBookingRoutes(
      db,
      sync,
      config.BASE_URL,
      now,
      (linkId, type, body) => {
        enqueueBookingEvent(webhookDeps, linkId, type, body);
        deps.webhooks.kick();
      },
      deps.mailer,
      config.ONEOFF_LINK_DAYS,
    ),
  );

  app.route("/pub", publicInviteRoutes(db));
  app.route("/", embedRoutes());
  app.route("/pub", publicBrandingRoutes(db));
  app.route("/scim/v2", scimRoutes(db, config.BASE_URL, now));
  const ssoDeps = {
    db,
    box,
    baseUrl: config.BASE_URL,
    seatLimit: config.TEAM_SEAT_LIMIT,
    now,
    startSession,
  };
  app.route("/auth/sso", ssoAuthRoutes(ssoDeps));

  const live = createLiveHub();
  sync.onChange((userId) => live.notify(userId));

  // Preview mode (assistant-preview-mode.md). Dry runs of automation edits use an
  // app on a second connection, inside a transaction that is rolled back.
  let dry: { app: Hono<AppEnv>; db: Db } | null | undefined;
  const preview = createPreview({
    db,
    sync,
    mailer: deps.mailer,
    live,
    now,
    app: () => app,
    dry: () => {
      if (dry === undefined) {
        const dryDb = config.dbPath === ":memory:" ? null : openDb(config.dbPath);
        dry = dryDb && {
          db: dryDb,
          app: createApp({
            ...deps,
            db: dryDb,
            sync: DRY_SYNC,
            // No static client: the dry app answers API calls only.
            config: { ...config, WEB_DIST: join(config.DATA_DIR, "no-web-client") },
          }),
        };
      }
      return dry;
    },
  });

  app.use("/api/*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const found = token ? sessionIdentity(db, token, now()) : undefined;
    if (found === "acting_ended")
      return c.json({ error: "acting_ended", message: "Your access to that account ended." }, 403);
    const user = found?.user ?? apiKeyUser(db, c.req.header("authorization"), now());
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    c.set("user", user);
    if (found?.actor) c.set("actor", found.actor);
    if (found) c.set("session", found.session);
    await next();
  });
  app.use("/api/*", delegationGuard(db, live, now));
  app.use("/api/*", preview.guard);

  app.get("/api/me", (c) => {
    const user = c.get("user");
    const actor = c.get("actor");
    return c.json({
      user,
      actor: actor ?? null,
      owners: ownersOf(db, (actor ?? user).id),
      settings: getSettings(db, user.id),
      accounts: all(
        db,
        `SELECT id, provider, email, status, grant_team_id IS NOT NULL AS viaGrant, is_main
         FROM accounts WHERE user_id = ? AND provider <> 'ics' ORDER BY created_at`,
        user.id,
      ),
    });
  });

  app.patch("/api/me", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({ timeZone: z.string().refine(isValidTimeZone, "Unknown time zone") }),
    );
    run(db, "UPDATE users SET time_zone = ? WHERE id = ?", body.timeZone, user.id);
    sync.request(user.id);
    return c.json({ ok: true });
  });

  app.route("/api", settingsRoutes(db, sync, now));
  app.route("/api", itemRoutes(db, sync, now));
  app.route("/api", meetingRoutes(db, sync, now, deps.mailer));
  app.route("/api/planner", plannerRoutes(db, sync, now));
  app.route("/api/booking", bookingRoutes(db, now, config.ONEOFF_LINK_DAYS));
  app.route("/api", webhookRoutes(db, box, config.WEBHOOK_ALLOW_PRIVATE, now));
  app.route("/api", statsRoutes(db, now));
  app.route("/api", analyticsRoutes(db, now));
  app.route("/api", policyRoutes(db, sync, now));
  app.route("/api", accountRoutes(db, box, sync, now));
  app.route("/api", delegationRoutes(db, live, now));
  app.route("/api", brandingRoutes(db, now));
  app.route(
    "/api",
    teamRoutes({
      db,
      box,
      mailer: deps.mailer,
      baseUrl: config.BASE_URL,
      seatLimit: config.TEAM_SEAT_LIMIT,
      now,
    }),
  );
  app.route("/api", ssoAdminRoutes(ssoDeps));
  app.route("/api", provisioningRoutes({ db, box, now }));

  app.route("/api", teamDefaultRoutes(db, now));
  app.route("/api", oooRoutes(db, sync, now));
  app.route(
    "/api",
    previewRoutes(
      db,
      preview,
      { baseUrl: config.BASE_URL, mcpWriteEnabled: config.MCP_WRITE_ENABLED },
      now,
    ),
  );
  app.route("/api", helpRoutes(db, config.SUPPORT_URL, now));
  app.route("/api", insightRoutes(db, now));
  app.route(
    "/mcp",
    mcpRoutes({
      db,
      preview,
      baseUrl: config.BASE_URL,
      writeEnabled: config.MCP_WRITE_ENABLED,
      now,
    }),
  );
  app.route("/api", eventActionRoutes(db, sync, now));
  app.route("/api", taskSearchRoutes(db, now));
  app.route("/api", focusExtraRoutes(db, sync, now));
  app.route("/api", bufferFilterRoutes(db, now));
  app.route("/api", meetingCheckRoutes(db, sync, now));
  app.route("/api", automationRoutes(db, sync));

  // Round 3 s4: connected calendars, holiday feeds and mirroring policies.
  app.route(
    "/api",
    calendarRoutes({ db, box, sync, allowPrivate: config.WEBHOOK_ALLOW_PRIVATE, now }),
  );
  app.route("/api", mirrorRoutes(db, sync, now));
  app.route("/api/booking", bookingViewerRoutes(db, now));
  app.route("/api/booking", bookingShareRoutes(db, now));
  // r3 s3: planner now line, task time, travel time zones, hours deletion.
  app.route("/api", nowRoutes(db, now));
  app.route("/api", taskTimeRoutes(db, sync, config.BASE_URL, now));
  app.route("/api", travelRoutes(db, sync, now));
  app.route("/api", hoursExtraRoutes(db, sync, now));

  // Static client with a single-page fallback. Text files are compressed once
  // per encoding and kept in memory; the build output does not change at run time.
  const encoded = new Map<string, Uint8Array<ArrayBuffer>>();
  const staticBody = async (file: string, encoding: "br" | "gzip" | null) => {
    const key = `${encoding}:${file}`;
    let body = encoded.get(key);
    if (!body) {
      const raw = await readFile(file);
      body = new Uint8Array(
        encoding === "br" ? brotliCompressSync(raw) : encoding === "gzip" ? gzipSync(raw) : raw,
      );
      encoded.set(key, body);
    }
    return body;
  };
  // Compress the build output at start, so the first visitor does not wait for it.
  void (async () => {
    for (const name of await readdir(config.WEB_DIST, { recursive: true })) {
      if (!/\.(html|js|css|svg|json)$/.test(name)) continue;
      const file = join(config.WEB_DIST, name);
      await staticBody(file, "br");
      await staticBody(file, "gzip");
    }
  })().catch(() => {});
  app.get("*", async (c) => {
    const path = normalize(decodeURIComponent(new URL(c.req.url).pathname));
    const isAsset = extname(path) !== "";
    const file = isAsset ? join(config.WEB_DIST, path) : join(config.WEB_DIST, "index.html");
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const accept = c.req.header("accept-encoding") ?? "";
    const encoding = !/^(text\/|application\/(javascript|json)|image\/svg)/.test(type)
      ? null
      : /\bbr\b/.test(accept)
        ? "br"
        : /\bgzip\b/.test(accept)
          ? "gzip"
          : null;
    try {
      const body = await staticBody(file, encoding);
      const cache = path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      return c.body(body, 200, {
        "content-type": type,
        "cache-control": cache,
        vary: "accept-encoding",
        ...(encoding ? { "content-encoding": encoding } : {}),
      });
    } catch {
      return c.text("Not found", 404);
    }
  });

  return app;
}
