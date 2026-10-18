// Team defaults for new members: habit templates, default hours and the focus
// time template (teams-settings-templates.md rules 3-11), and what a new member
// sees from them: onboarding and the focus recommendation.
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import {
  type FocusTemplate,
  focusTemplateSchema,
  setTeamSetting,
  teamDefaults,
  teamSetting,
  weeklySchema,
} from "../team-defaults.ts";
import { type Membership, membership } from "../teams.ts";
import { hhmm } from "./items.ts";

const templateInput = z.object({
  title: z.string().trim().min(1).max(255),
  idealTime: hhmm,
  minutes: z.number().int().min(15).max(720).multipleOf(15),
  /** ISO weekdays; null: every day of its hours. */
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable(),
  level: z.number().int().min(1).max(4).default(3),
  hours: z.enum(["work", "personal"]).default("work"),
});

const forbidden = (): never => {
  throw new HTTPException(403, { res: Response.json({ error: "forbidden" }, { status: 403 }) });
};

interface TemplateRow {
  id: string;
  title: string;
  fields: string;
}

export function teamDefaultRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const admin = (c: Context<AppEnv>): Membership => {
    const m = membership(db, c.get("user").id);
    if (m.role !== "admin") forbidden();
    return m;
  };
  const templates = (teamId: string) =>
    all<TemplateRow>(
      db,
      "SELECT id, title, fields FROM team_habit_templates WHERE team_id = ? ORDER BY created_at",
      teamId,
    ).map((t) => ({ id: t.id, title: t.title, ...JSON.parse(t.fields) }));

  // Every member reads the templates (rule 5); only admins change anything (rule 1).
  r.get("/team/defaults", (c) => {
    const { team, role } = membership(db, c.get("user").id);
    return c.json({
      canManage: role === "admin",
      templates: templates(team.id),
      ...teamDefaults(db, team.id),
    });
  });

  r.patch("/team/defaults", async (c) => {
    const { team } = admin(c);
    const body = await jsonBody(
      c,
      z.object({
        workHours: weeklySchema.nullable().optional(),
        meetingHours: weeklySchema.nullable().optional(),
        focus: focusTemplateSchema.nullable().optional(),
      }),
    );
    const current = teamSetting(db, team.id, "defaults");
    setTeamSetting(db, team.id, "defaults", {
      ...(current && typeof current === "object" ? current : {}),
      ...body,
    });
    return c.json(teamDefaults(db, team.id));
  });

  r.post("/team/habit-templates", async (c) => {
    const { team } = admin(c);
    const { title, ...fields } = await jsonBody(c, templateInput);
    const id = randomUUID();
    run(
      db,
      "INSERT INTO team_habit_templates (id, team_id, title, fields, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      team.id,
      title,
      JSON.stringify(fields),
      now(),
    );
    return c.json({ id }, 201);
  });

  // Habits made from a template keep their own fields (edge cases 1, 2).
  r.put("/team/habit-templates/:id", async (c) => {
    const { team } = admin(c);
    const { title, ...fields } = await jsonBody(c, templateInput);
    const id = c.req.param("id");
    if (!one(db, "SELECT 1 FROM team_habit_templates WHERE id = ? AND team_id = ?", id, team.id))
      notFound("template");
    run(
      db,
      "UPDATE team_habit_templates SET title = ?, fields = ? WHERE id = ?",
      title,
      JSON.stringify(fields),
      id,
    );
    return c.json({ ok: true });
  });

  r.delete("/team/habit-templates/:id", (c) => {
    const { team } = admin(c);
    run(
      db,
      "DELETE FROM team_habit_templates WHERE id = ? AND team_id = ?",
      c.req.param("id"),
      team.id,
    );
    return c.body(null, 204);
  });

  const onboarding = (userId: string) =>
    one<{ team_id: string; focus: string | null; focus_state: string; welcome_done: number }>(
      db,
      `SELECT o.team_id, o.focus, o.focus_state, o.welcome_done FROM team_onboarding o
       JOIN team_members m ON m.user_id = o.user_id AND m.team_id = o.team_id WHERE o.user_id = ?`,
      userId,
    );

  /** The new member's onboarding step and pending focus recommendation (rules 4, 9). */
  r.get("/team/onboarding", (c) => {
    const { team } = membership(db, c.get("user").id);
    const o = onboarding(c.get("user").id);
    return c.json({
      team: team.name,
      welcome: o !== undefined && o.welcome_done === 0,
      templates: o && o.welcome_done === 0 ? templates(team.id) : [],
      focus:
        o?.focus_state === "pending" && o.focus ? (JSON.parse(o.focus) as FocusTemplate) : null,
    });
  });

  r.post("/team/onboarding/done", (c) => {
    run(db, "UPDATE team_onboarding SET welcome_done = 1 WHERE user_id = ?", c.get("user").id);
    return c.json({ ok: true });
  });

  /** The member accepted (after the focus goal was saved) or switched off the recommendation. */
  r.post("/team/focus-recommendation", async (c) => {
    const { state } = await jsonBody(c, z.object({ state: z.enum(["accepted", "off"]) }));
    run(
      db,
      "UPDATE team_onboarding SET focus_state = ? WHERE user_id = ? AND focus_state = 'pending'",
      state,
      c.get("user").id,
    );
    return c.json({ ok: true });
  });

  return r;
}
