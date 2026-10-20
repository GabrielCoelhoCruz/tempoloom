// Troubleshooting (docs/specs/support-troubleshooting.md): the support contact,
// the event lookup, and the planner's onboarding hints (platform-current-version.md rule 17;
// the first mirroring policy, sync-calendar-mirroring.md rule 11).
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { lookupEvent } from "../diagnosis.ts";
import { notFound } from "../http.ts";
import type { SyncService } from "../sync/service.ts";
import { listedCalendars } from "./calendars.ts";

type Hint = "other-tools" | "first-mirror";

/** Hints the planner shows until the user dismisses them, each while its test holds. */
const hints = (db: Db): Record<Hint, (userId: string) => boolean> => ({
  "other-tools": () => true,
  // The first policy is offered while the user has none and two calendars to link.
  "first-mirror": (userId) =>
    !one(db, "SELECT 1 FROM mirror_policies WHERE user_id = ?", userId) &&
    listedCalendars(db, userId).filter((cal) => cal.provider !== "ics").length > 1,
});

export function helpRoutes(
  db: Db,
  supportUrl: string | undefined,
  now: () => number,
  sync: SyncService,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const shown = hints(db);

  r.get("/help", (c) => c.json({ supportUrl: supportUrl ?? null }));

  const lookup = (userId: string, q: string) => {
    const result = lookupEvent(db, userId, q, now());
    if ("error" in result) return result;
    const { repair, ...shown } = result;
    return { ...shown, repairable: repair.length > 0 };
  };

  r.get("/help/lookup", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q || q.length > 2000) return c.json({ error: "unreadable" }, 400);
    const result = lookup(c.get("user").id, q);
    return "error" in result ? c.json(result, 404) : c.json(result);
  });

  /** Rule 10: runs the copy decision again for the event and writes the result. */
  r.post("/help/repair", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { q?: unknown };
    const q = typeof body.q === "string" ? body.q.trim() : "";
    if (!q || q.length > 2000) return c.json({ error: "unreadable" }, 400);
    const userId = c.get("user").id;
    const found = lookupEvent(db, userId, q, now());
    if ("error" in found) return c.json(found, 404);
    if (found.repair.length === 0) return c.json({ error: "nothing_to_repair" }, 409);
    const repaired = await sync.repair(userId, found.repair);
    const result = lookup(userId, q);
    if ("error" in result) return c.json(result, 404);
    // The run failed or left the event as it was: the page says so (rule 10).
    return c.json({ ...result, repaired }, repaired ? 200 : 502);
  });

  r.get("/hints", (c) => {
    const dismissed = new Set(
      all<{ hint: string }>(
        db,
        "SELECT hint FROM dismissed_hints WHERE user_id = ?",
        c.get("user").id,
      ).map((h) => h.hint),
    );
    const userId = c.get("user").id;
    return c.json({
      hints: (Object.keys(shown) as Hint[]).filter((h) => !dismissed.has(h) && shown[h](userId)),
    });
  });

  r.post("/hints/:hint/dismiss", (c) => {
    const hint = c.req.param("hint");
    if (!Object.hasOwn(shown, hint)) notFound("hint");
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
