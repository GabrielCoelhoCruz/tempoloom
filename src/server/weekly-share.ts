// The public share page of a weekly report's top part (docs/specs/
// analytics-weekly-reports.md rules 10-12, edge case 6). The report stores the
// part as sent (weekly-report.ts). A share link of the email opens a confirm
// page; only its form (a POST with a token) makes the page public, so a mail
// scanner that opens every link shares nothing. The owner can stop sharing in
// Settings. The page needs no login, is not indexed, and shows the display name
// only when the user set one, the week, the three totals and the calendar facts.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./app.ts";
import { all, type Db, one, run } from "./db.ts";
import { notFound } from "./http.ts";

interface Share {
  token: string;
  name: string | null;
  week_from: string;
  week_to: string;
  totals: string;
  facts: string;
  shared_at: number | null;
}

/**
 * Rule 12 decision: the page shows a name only when it is a display name the
 * user set (from Google or the directory). An email address, the local part of
 * one of the user's emails, a CalDAV user name or a directory (SCIM) user name
 * is a login, not a display name, so the page shows no name.
 */
export function publicName(db: Db, userId: string): string | null {
  const user = one<{ name: string; email: string }>(
    db,
    "SELECT name, email FROM users WHERE id = ?",
    userId,
  );
  if (!user) return null;
  const name = user.name.trim();
  const lower = name.toLowerCase();
  const accounts = all<{ provider: string; external_id: string; email: string }>(
    db,
    "SELECT provider, external_id, email FROM accounts WHERE user_id = ?",
    userId,
  );
  const directory = one<{ resource: string }>(
    db,
    "SELECT resource FROM directory_profiles WHERE user_id = ?",
    userId,
  );
  const scimUser = directory
    ? (JSON.parse(directory.resource) as { userName?: unknown }).userName
    : undefined;
  const logins = new Set([
    ...(typeof scimUser === "string" ? [scimUser.toLowerCase()] : []),
    ...[user.email, ...accounts.map((a) => a.email)].map((e) => e.split("@")[0]?.toLowerCase()),
    ...accounts
      .filter((a) => a.provider === "caldav")
      .map((a) => a.external_id.slice(a.external_id.lastIndexOf("|") + 1).toLowerCase()),
  ]);
  return name && !name.includes("@") && !logins.has(lower) ? name : null;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rule 11: each social target opens that site's share dialog with the page link. */
const DIALOGS: Record<string, (page: string) => string> = {
  x: (p) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(p)}`,
  linkedin: (p) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(p)}`,
  facebook: (p) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(p)}`,
};
const TARGET_NAMES: Record<string, string> = {
  link: "a direct link",
  x: "X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

/** Search engines skip the page; links from it send no referrer. */
const HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};
const head = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1f2937}
.facts li{display:inline-block;margin:4px;padding:8px 12px;border-radius:6px;background:#dbeafe}
.facts ul{padding:0}
</style>
</head>`;

const NOT_FOUND = `${head("Not found")}<body><p>Not found.</p></body></html>`;

function page(s: Share): string {
  const list = (items: string[], id: string) =>
    `<ul data-testid="${id}">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const facts = JSON.parse(s.facts) as string[];
  const title = s.name ? `${s.name}'s week` : "A week in review";
  return `${head(title)}
<body>
<main data-testid="shared-report">
<h1>${esc(title)}</h1>
<p>${esc(s.week_from)} to ${esc(s.week_to)}</p>
<h2>Time</h2>
${list(JSON.parse(s.totals) as string[], "shared-totals")}
<h2>Calendar facts</h2>
<div class="facts">${facts.length ? list(facts, "shared-facts") : "<p>No facts this week.</p>"}</div>
<p><small>Made with Tempoloom</small></p>
</main>
</body>
</html>`;
}

function confirmPage(s: Share, to: string, csrf: string): string {
  return `${head("Share your week")}
<body>
<main data-testid="share-confirm">
<h1>Share your week</h1>
<p>This makes a public page with the totals and the calendar facts of ${esc(s.week_from)} to ${esc(s.week_to)}. Event titles are not on it. You can stop sharing in Settings.</p>
<form method="post">
<input type="hidden" name="to" value="${esc(to)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<button type="submit">Share on ${esc(TARGET_NAMES[to] ?? to)}</button>
</form>
</main>
</body>
</html>`;
}

const RATE_WINDOW = 60_000;
/**
 * Publish POSTs per share and minute. The limit is per share token, so a flood
 * on one share does not block another user's; the pages themselves are cheap
 * reads of one row by a 192-bit token and have no limit.
 */
const POST_LIMIT = 10;
const CSRF_COOKIE = "tl_share";

const same = (a: string, b: string) =>
  a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function weeklyShareRoutes(db: Db, baseUrl: string, now: () => number): Hono {
  const r = new Hono();
  const origin = new URL(baseUrl).origin;
  const secure = baseUrl.startsWith("https://");
  const hits = new Map<string, { start: number; count: number }>();
  const find = (token: string) =>
    one<Share>(
      db,
      "SELECT token, name, week_from, week_to, totals, facts, shared_at FROM weekly_shares WHERE token = ?",
      token,
    );
  const pageUrl = (token: string) => new URL(`/r/${token}`, baseUrl).toString();
  const target = (token: string, to: string) =>
    to === "link" ? pageUrl(token) : (DIALOGS[to]?.(pageUrl(token)) ?? pageUrl(token));

  /** Counts one publish POST of `token`; false when the share is over its limit. */
  const allowPost = (token: string) => {
    const t = now();
    const hit = hits.get(token);
    if (!hit || t - hit.start >= RATE_WINDOW) {
      if (hits.size > 10_000) hits.clear();
      hits.set(token, { start: t, count: 1 });
      return true;
    }
    return ++hit.count <= POST_LIMIT;
  };

  // Rule 11: a share link of the email asks before it makes the page public.
  r.get("/:token/share", (c) => {
    const share = find(c.req.param("token"));
    const to = c.req.query("to") ?? "link";
    if (!share || !TARGET_NAMES[to]) return c.html(NOT_FOUND, 404, HEADERS);
    if (share.shared_at !== null) return c.redirect(target(share.token, to), 302);
    const csrf = randomBytes(18).toString("base64url");
    setCookie(c, CSRF_COOKIE, csrf, {
      httpOnly: true,
      sameSite: "Strict",
      secure,
      path: `/r/${share.token}`,
      maxAge: 3600,
    });
    return c.html(confirmPage(share, to, csrf), 200, HEADERS);
  });

  // The confirm form: the user's explicit action makes the page public.
  r.post("/:token/share", async (c) => {
    const share = find(c.req.param("token"));
    const form = await c.req.parseBody();
    const to = typeof form.to === "string" ? form.to : "";
    if (!share || !TARGET_NAMES[to]) return c.html(NOT_FOUND, 404, HEADERS);
    if (!allowPost(share.token))
      return c.text("Too many requests.", 429, { ...HEADERS, "retry-after": "60" });
    // With no-referrer the browser sends "null" as the origin; the SameSite
    // cookie that must match the form's token keeps other sites out.
    const sentFrom = c.req.header("origin") ?? "null";
    const csrf = typeof form.csrf === "string" ? form.csrf : "";
    if (![origin, "null"].includes(sentFrom) || !same(csrf, getCookie(c, CSRF_COOKIE) ?? ""))
      return c.text("Open the share link from the email again.", 403, HEADERS);
    if (share.shared_at === null)
      run(db, "UPDATE weekly_shares SET shared_at = ? WHERE token = ?", now(), share.token);
    return c.redirect(target(share.token, to), 303);
  });

  // Rule 12: no login; only a page that the user shared and did not stop sharing.
  r.get("/:token", (c) => {
    const share = find(c.req.param("token"));
    if (!share || share.shared_at === null) return c.html(NOT_FOUND, 404, HEADERS);
    return c.html(page(share), 200, HEADERS);
  });
  r.notFound((c) => c.html(NOT_FOUND, 404, HEADERS));
  return r;
}

/** Open question 4 decision: the owner lists the shared weeks and stops sharing any of them. */
export function weeklyShareApi(db: Db, baseUrl: string): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/weekly-shares", (c) => {
    const rows = all<{ token: string; week_from: string; week_to: string; shared_at: number }>(
      db,
      `SELECT token, week_from, week_to, shared_at FROM weekly_shares
       WHERE user_id = ? AND shared_at IS NOT NULL ORDER BY week_from DESC, shared_at DESC`,
      c.get("user").id,
    );
    return c.json({
      shares: rows.map((s) => ({
        id: s.token,
        weekFrom: s.week_from,
        weekTo: s.week_to,
        sharedAt: s.shared_at,
        url: new URL(`/r/${s.token}`, baseUrl).toString(),
      })),
    });
  });
  r.post("/weekly-shares/:id/stop", (c) => {
    const changed = db
      .prepare(
        "UPDATE weekly_shares SET shared_at = NULL WHERE token = ? AND user_id = ? AND shared_at IS NOT NULL",
      )
      .run(c.req.param("id"), c.get("user").id).changes;
    if (changed !== 1) notFound("shared week");
    return c.json({ ok: true });
  });
  return r;
}
