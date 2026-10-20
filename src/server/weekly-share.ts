// The public share page of a weekly report's top part (docs/specs/
// analytics-weekly-reports.md rules 10-12, edge case 6). The report stores the
// part as sent (weekly-report.ts); a share link from the email makes it public
// and goes to the page or to a site's share dialog. The page needs no login and
// shows the display name, the week, the three totals and the calendar facts.
import { Hono } from "hono";
import { type Db, one, run } from "./db.ts";

interface Share {
  token: string;
  name: string;
  week_from: string;
  week_to: string;
  totals: string;
  facts: string;
  shared_at: number | null;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rule 11: each social target opens that site's share dialog with the page link. */
const DIALOGS: Record<string, (page: string) => string> = {
  x: (p) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(p)}`,
  linkedin: (p) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(p)}`,
  facebook: (p) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(p)}`,
};

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><p>Not found.</p></body></html>`;

function page(s: Share): string {
  const list = (items: string[], id: string) =>
    `<ul data-testid="${id}">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const facts = JSON.parse(s.facts) as string[];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.name)}: your week</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1f2937}
.facts li{display:inline-block;margin:4px;padding:8px 12px;border-radius:6px;background:#dbeafe}
.facts ul{padding:0}
</style>
</head>
<body>
<main data-testid="shared-report">
<h1>${esc(s.name)}: your week</h1>
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

export function weeklyShareRoutes(db: Db, baseUrl: string, now: () => number): Hono {
  const r = new Hono();
  const find = (token: string) =>
    one<Share>(
      db,
      `SELECT s.token, u.name, s.week_from, s.week_to, s.totals, s.facts, s.shared_at
       FROM weekly_shares s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      token,
    );

  // Rule 11: a share action makes the page public, then goes to its target.
  r.get("/:token/share", (c) => {
    const share = find(c.req.param("token"));
    const to = c.req.query("to") ?? "link";
    if (!share || (to !== "link" && !DIALOGS[to])) return c.html(NOT_FOUND, 404);
    if (share.shared_at === null)
      run(db, "UPDATE weekly_shares SET shared_at = ? WHERE token = ?", now(), share.token);
    const pageUrl = new URL(`/r/${share.token}`, baseUrl).toString();
    return c.redirect(to === "link" ? pageUrl : (DIALOGS[to]?.(pageUrl) ?? pageUrl), 302);
  });

  // Rule 12: no login; only a page that a share action made public.
  r.get("/:token", (c) => {
    const share = find(c.req.param("token"));
    if (!share || share.shared_at === null) return c.html(NOT_FOUND, 404);
    return c.html(page(share), 200, { "cache-control": "no-store" });
  });
  return r;
}
