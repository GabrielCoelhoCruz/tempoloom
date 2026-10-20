// Deleting a custom hours set with a replacement (docs/specs/planning-hours.md
// HRS-10, AT-H4) and the description of focus time events
// (docs/specs/tools-pomodoro-timer.md rule 19).
import { Hono } from "hono";
import { z } from "zod";
import { defaultEventSettings, readEventSettings } from "../../shared/event-settings.ts";
import type { AppEnv } from "../app.ts";
import { type Db, one, run, tx } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { wakeOrganizers } from "../planner/meetings.ts";
import type { SyncService } from "../sync/service.ts";

/** Tables whose rows need an hours set; link hours fall back to the meeting hours on their own. */
const USERS = ["tasks", "habits", "focus_goals", "meetings"] as const;

export function hoursExtraRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const customSet = (userId: string, id: string) =>
    one<{ id: string; name: string }>(
      db,
      "SELECT id, name FROM hours_sets WHERE id = ? AND user_id = ? AND kind = 'custom' AND item_specific = 0",
      id,
      userId,
    );
  const usage = (id: string) =>
    USERS.reduce(
      (n, t) =>
        n +
        (one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t} WHERE hours_set_id = ?`, id)?.n ??
          0),
      0,
    );

  r.get("/hours/:id/usage", (c) => {
    const set = customSet(c.get("user").id, c.req.param("id"));
    if (!set) notFound("hours set");
    return c.json({ count: usage(set.id) });
  });

  /** HRS-10: a set in use goes only with a replacement; its items move there. */
  r.delete("/hours/:id", async (c) => {
    const user = c.get("user");
    const set = customSet(user.id, c.req.param("id"));
    if (!set) notFound("hours set");
    const { replacementId } = await jsonBody(c, z.object({ replacementId: z.string().optional() }));
    const count = usage(set.id);
    const replacement =
      replacementId &&
      one<{ id: string }>(
        db,
        "SELECT id FROM hours_sets WHERE id = ? AND user_id = ? AND id <> ? AND item_specific = 0",
        replacementId,
        user.id,
        set.id,
      );
    if (count > 0 && !replacement)
      return c.json(
        { error: "in_use", count, message: "Choose other hours for the items that use this set." },
        409,
      );
    tx(db, () => {
      if (replacement)
        for (const t of USERS)
          run(
            db,
            `UPDATE ${t} SET hours_set_id = ?, rules_changed_at = ? WHERE hours_set_id = ?`,
            replacement.id,
            now(),
            set.id,
          );
      run(db, "DELETE FROM hours_sets WHERE id = ?", set.id);
    });
    sync.request(user.id, 0);
    wakeOrganizers(db, sync, user.id);
    return c.body(null, 204);
  });

  r.put("/focus/:id/notes", async (c) => {
    const user = c.get("user");
    const { notes } = await jsonBody(c, z.object({ notes: z.string().max(10_000) }));
    const id = c.req.param("id");
    const row = one<{ event_settings: string }>(
      db,
      "SELECT event_settings FROM focus_goals WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    if (!row) notFound("focus time");
    // The description is one of the focus time's event settings (focus-time.md).
    const es = readEventSettings(row.event_settings, defaultEventSettings("focus_time"));
    run(
      db,
      "UPDATE focus_goals SET event_settings = ? WHERE id = ?",
      JSON.stringify({ ...es, description: notes }),
      id,
    );
    sync.request(user.id);
    return c.json({ ok: true });
  });

  return r;
}
