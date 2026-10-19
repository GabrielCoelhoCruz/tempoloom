// Troubleshooting (docs/specs/support-troubleshooting.md): the support contact,
// the event lookup, and the planner's onboarding hints (platform-current-version.md rule 17).
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { all, type Db, run } from "../db.ts";
import { lookupEvent } from "../diagnosis.ts";
import { notFound } from "../http.ts";

/** Hints the planner shows until the user dismisses them. */
const HINTS = ["other-tools"] as const;

export function helpRoutes(
  db: Db,
  supportUrl: string | undefined,
  now: () => number,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/help", (c) => c.json({ supportUrl: supportUrl ?? null }));

  r.get("/help/lookup", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q || q.length > 2000) return c.json({ error: "unreadable" }, 400);
    const result = lookupEvent(db, c.get("user").id, q, now());
    return "error" in result ? c.json(result, 404) : c.json(result);
  });

  r.get("/hints", (c) => {
    const dismissed = new Set(
      all<{ hint: string }>(
        db,
        "SELECT hint FROM dismissed_hints WHERE user_id = ?",
        c.get("user").id,
      ).map((h) => h.hint),
    );
    return c.json({ hints: HINTS.filter((h) => !dismissed.has(h)) });
  });

  r.post("/hints/:hint/dismiss", (c) => {
    const hint = c.req.param("hint");
    if (!(HINTS as readonly string[]).includes(hint)) notFound("hint");
    run(
      db,
      "INSERT OR IGNORE INTO dismissed_hints (user_id, hint, dismissed_at) VALUES (?, ?, ?)",
      c.get("user").id,
      hint,
      now(),
    );
    return c.json({ ok: true });
  });

  return r;
}
