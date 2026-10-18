// Team out-of-office calendars in team settings (teams-ooo-calendar.md rules
// 1-9): the list with participants, the admin settings, add and delete.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import {
  deleteCopies,
  oooSettings,
  oooSettingsSchema,
  ownedTargets,
  refreshAccess,
} from "../ooo.ts";
import type { SyncService } from "../sync/service.ts";
import { setTeamSetting } from "../team-defaults.ts";
import { membership } from "../teams.ts";

const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 });

export function oooRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/team/ooo", (c) => {
    const user = c.get("user");
    const { team, role } = membership(db, user.id);
    const settings = oooSettings(db, team.id);
    const rows = all<{
      id: string;
      name: string;
      owner_id: string;
      owner_name: string;
      owner_email: string;
      calendar: string | null;
      owner_in_team: number;
    }>(
      db,
      `SELECT o.id, o.name, o.owner_id, u.name AS owner_name, u.email AS owner_email, c.name AS calendar,
         EXISTS (SELECT 1 FROM team_members m WHERE m.user_id = o.owner_id AND m.team_id = o.team_id) AS owner_in_team
       FROM ooo_calendars o JOIN users u ON u.id = o.owner_id LEFT JOIN calendars c ON c.id = o.calendar_id
       WHERE o.team_id = ? ORDER BY o.created_at`,
      team.id,
    );
    return c.json({
      isAdmin: role === "admin",
      canCreate: role === "admin" || settings.allowMembers,
      settings,
      calendars: rows.map((o) => ({
        id: o.id,
        name: o.name,
        owner: { name: o.owner_name, email: o.owner_email },
        calendar: o.calendar,
        // Participants: team members with write access (rules 6, 7).
        participants: all<{ name: string; email: string }>(
          db,
          `SELECT u.name, u.email FROM ooo_access a JOIN users u ON u.id = a.user_id
             JOIN team_members m ON m.user_id = u.id AND m.team_id = ?
           WHERE a.ooo_id = ? AND a.access = 'write' ORDER BY u.email`,
          team.id,
          o.id,
        ),
        problem: !o.owner_in_team
          ? "The owner left the team. Copying has stopped."
          : o.calendar === null
            ? "The shared calendar is gone. Copying has stopped."
            : null,
        canDelete: role === "admin" || o.owner_id === user.id,
      })),
    });
  });

  r.patch("/team/ooo/settings", async (c) => {
    const { team, role } = membership(db, c.get("user").id);
    if (role !== "admin") return forbidden();
    const body = await jsonBody(c, oooSettingsSchema.partial());
    setTeamSetting(db, team.id, "ooo", { ...oooSettings(db, team.id), ...body });
    return c.json({ settings: oooSettings(db, team.id) });
  });

  // Rules 2, 3: admins, or any member while the team allows it. The owner is the
  // creating user and the target is one of their writable calendars.
  r.post("/team/ooo", async (c) => {
    const user = c.get("user");
    const { team, role } = membership(db, user.id);
    if (role !== "admin" && !oooSettings(db, team.id).allowMembers) return forbidden();
    const body = await jsonBody(
      c,
      z.object({ name: z.string().trim().min(1).max(100), calendarId: z.string().min(1) }),
    );
    const cal = one<{ writable: number }>(
      db,
      `SELECT c.writable FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE c.id = ? AND a.user_id = ? AND a.status = 'ok'`,
      body.calendarId,
      user.id,
    );
    if (!cal) notFound("calendar");
    if (!cal.writable) return c.json({ error: "calendar_read_only" }, 400);
    const id = randomUUID();
    run(
      db,
      `INSERT INTO ooo_calendars (id, team_id, name, owner_id, calendar_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      team.id,
      body.name,
      user.id,
      body.calendarId,
      now(),
    );
    // Rule 6: participants are active at once, with no further action.
    await sync.exclusive(user.id, async (pool) => {
      const target = ownedTargets(db, user.id).find((t) => t.id === id);
      if (target) await refreshAccess(db, target, pool, now(), true);
    });
    return c.json({ id }, 201);
  });

  r.delete("/team/ooo/:id", async (c) => {
    const user = c.get("user");
    const { team, role } = membership(db, user.id);
    const o = one<{ owner_id: string }>(
      db,
      "SELECT owner_id FROM ooo_calendars WHERE id = ? AND team_id = ?",
      c.req.param("id"),
      team.id,
    );
    if (!o) notFound("out-of-office calendar");
    if (role !== "admin" && o.owner_id !== user.id) return forbidden();
    const id = c.req.param("id");
    await sync.exclusive(o.owner_id, (pool) => deleteCopies(db, id, pool, now()));
    run(db, "DELETE FROM ooo_calendars WHERE id = ?", id);
    return c.body(null, 204);
  });

  return r;
}
