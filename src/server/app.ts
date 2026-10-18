import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import {
  createSession,
  deleteSession,
  type User,
  upsertGoogleLogin,
  userForSession,
} from "./accounts.ts";
import type { Config } from "./config.ts";
import type { SecretBox } from "./crypto.ts";
import { type Db, one, run } from "./db.ts";
import {
  buildAuthRequest,
  exchangeCode,
  identityFromIdToken,
  type OAuthClient,
} from "./google/oauth.ts";

export interface AppDeps {
  db: Db;
  config: Config;
  box: SecretBox;
  oauth: OAuthClient | undefined;
  /** Called after a login so the account's calendars sync right away. */
  onLogin: (userId: string, accountId: string) => void;
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

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { db, config, box } = deps;
  const now = deps.now ?? Date.now;
  const secure = config.BASE_URL.startsWith("https://");
  const app = new Hono<AppEnv>();

  app.use("/api/*", csrf({ origin: new URL(config.BASE_URL).origin }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

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
    const tokens = await exchangeCode(deps.oauth, code, saved.code_verifier, now());
    if (!tokens.idToken) return c.redirect("/?login_error=no_identity");
    const { user, accountId } = upsertGoogleLogin(
      db,
      box,
      identityFromIdToken(tokens.idToken),
      tokens,
      now(),
    );
    setCookie(c, SESSION_COOKIE, createSession(db, user.id, now()), {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      path: "/",
      maxAge: 30 * 86_400,
    });
    deps.onLogin(user.id, accountId);
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

  app.get("/api/me", (c) => c.json({ user: c.get("user") }));

  // Static client with a single-page fallback.
  app.get("*", async (c) => {
    const path = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(
      /^(\.\.[/\\])+/,
      "",
    );
    const file = join(config.WEB_DIST, path === "/" ? "index.html" : path);
    const isAsset = extname(path) !== "";
    try {
      const body = await readFile(isAsset ? file : join(config.WEB_DIST, "index.html"));
      const type = MIME[extname(isAsset ? file : "index.html")] ?? "application/octet-stream";
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
