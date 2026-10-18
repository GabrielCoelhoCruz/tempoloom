import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
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
  type User,
  upsertAccount,
  upsertGoogleLogin,
  userForSession,
} from "./accounts.ts";
import { itemRoutes } from "./api/items.ts";
import { plannerRoutes } from "./api/planner.ts";
import { settingsRoutes } from "./api/settings.ts";
import type { Config } from "./config.ts";
import type { SecretBox } from "./crypto.ts";
import { all, type Db, one, run } from "./db.ts";
import {
  buildAuthRequest,
  exchangeCode,
  identityFromIdToken,
  type OAuthClient,
} from "./google/oauth.ts";
import { jsonBody } from "./http.ts";
import { CalDavProvider } from "./providers/caldav.ts";
import { ProviderError } from "./providers/types.ts";
import { getSettings } from "./settings.ts";
import type { SyncService } from "./sync/service.ts";

export interface AppDeps {
  db: Db;
  config: Config;
  box: SecretBox;
  oauth: OAuthClient | undefined;
  sync: SyncService;
  now?: () => number;
}

export type AppEnv = { Variables: { user: User } };

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

const caldavLogin = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
  email: z.email().optional(),
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").optional(),
});

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { db, config, box, sync } = deps;
  const now = deps.now ?? Date.now;
  const secure = config.BASE_URL.startsWith("https://");
  const origin = new URL(config.BASE_URL).origin;
  const app = new Hono<AppEnv>();

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
      const { user, accountId } = upsertGoogleLogin(
        db,
        box,
        identityFromIdToken(tokens.idToken),
        tokens,
        now(),
      );
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
    const isNew = !one(db, "SELECT 1 FROM users WHERE email = ?", email);
    const user = ensureUser(db, email, body.username, now());
    // CalDAV has no account time zone; take the browser's on first sign-in.
    if (isNew && body.timeZone)
      run(db, "UPDATE users SET time_zone = ? WHERE id = ?", body.timeZone, user.id);
    const accountId = upsertAccount(
      db,
      box,
      {
        userId: user.id,
        provider: "caldav",
        externalId: `${new URL(body.serverUrl).href}|${body.username}`,
        email,
        serverUrl: body.serverUrl,
        credentials: { username: body.username, password: body.password },
      },
      now(),
    );
    startSession(c, user.id);
    await sync.onConnect(user.id, accountId);
    return c.json({ ok: true });
  });

  app.get("/auth/link/:token", (c) => {
    const userId = consumeLoginLink(db, c.req.param("token"), now());
    if (!userId) return c.redirect("/?login_error=link_expired");
    startSession(c, userId);
    return c.redirect("/");
  });

  app.post("/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession(db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  app.use("/api/*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? userForSession(db, token, now()) : undefined;
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    c.set("user", user);
    await next();
  });

  app.get("/api/me", (c) => {
    const user = c.get("user");
    return c.json({
      user,
      settings: getSettings(db, user.id),
      accounts: all(
        db,
        "SELECT id, provider, email, status FROM accounts WHERE user_id = ? ORDER BY created_at",
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
  app.route("/api/planner", plannerRoutes(db, sync, now));

  // Static client with a single-page fallback.
  app.get("*", async (c) => {
    const path = normalize(decodeURIComponent(new URL(c.req.url).pathname));
    const isAsset = extname(path) !== "";
    const file = isAsset ? join(config.WEB_DIST, path) : join(config.WEB_DIST, "index.html");
    try {
      const body = await readFile(file);
      const type = MIME[extname(file)] ?? "application/octet-stream";
      const cache = path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      return c.body(body, 200, { "content-type": type, "cache-control": cache });
    } catch {
      return c.text("Not found", 404);
    }
  });

  return app;
}
