// Team policies (docs/specs/teams-policies.md): admins manage policies, agenda
// templates and reports; each member sees the policies that apply to them,
// personalizes them, and handles agenda reminders.
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { directoryAttributes } from "../directory.ts";
import { jsonBody, notFound } from "../http.ts";
import { BUILTIN_TEMPLATES, declinedOf, reminderEvent, remindersOf } from "../policies/agendas.ts";
import { desiredFor, type Link, removeAutomations } from "../policies/apply.ts";
import {
  FLEXIBILITY,
  flexibilityOf,
  goalSchemas,
  MEETING_CATEGORIES,
  POLICY_TYPES,
  type Policy,
  type PolicyRow,
  parsePolicy,
  scopeRule,
  teamPolicies,
  winningPolicies,
} from "../policies/model.ts";
import { policyReport } from "../policies/reports.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";
import { type Membership, membership, teamMembers } from "../teams.ts";

const forbidden = (): never => {
  throw new HTTPException(403, { res: Response.json({ error: "forbidden" }, { status: 403 }) });
};

const policyInput = z.object({
  type: z.enum(POLICY_TYPES),
  name: z.string().trim().min(1).max(100),
  scope: z.array(scopeRule).max(10).default([]),
  goal: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(false),
});

const policyPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  scope: z.array(scopeRule).max(10).optional(),
  goal: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

/** Parses a goal for its type; a bad field is a 400 with the field path. */
function goalFor(type: Policy["type"], raw: unknown): unknown {
  const parsed = goalSchemas[type].safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      res: Response.json(
        {
          error: "invalid_body",
          issues: parsed.error.issues.map((i) => ({
            path: ["goal", ...i.path].join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    });
  }
  return parsed.data;
}

const view = (p: Policy) => ({
  id: p.id,
  type: p.type,
  name: p.name,
  scope: p.scope,
  goal: p.goal,
  enabled: p.enabled,
  startedAt: p.startedAt,
});

export function policyRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const mine = (c: Context<AppEnv>): Membership => membership(db, c.get("user").id);
  const admin = (c: Context<AppEnv>): Membership => {
    const m = mine(c);
    if (m.role !== "admin") forbidden();
    return m;
  };
  /** Rule 2: a policy change reaches every member at their next run, started now. */
  const replanTeam = (teamId: string) => {
    for (const m of teamMembers(db, teamId)) sync.request(m.userId, 0);
  };
  const policyOf = (c: Context<AppEnv>, teamId: string): Policy => {
    const row = one<PolicyRow>(
      db,
      "SELECT * FROM team_policies WHERE id = ? AND team_id = ?",
      c.req.param("id") ?? "",
      teamId,
    );
    if (!row) notFound("policy");
    return parsePolicy(row);
  };

  // ------------------------------------------------------------ admins (rule 1)
  r.get("/policies", (c) => {
    const { team } = admin(c);
    const names = new Set<string>();
    for (const a of directoryAttributes(db, team.id).values()) {
      for (const k of Object.keys(a)) if (k !== "userName" && k !== "displayName") names.add(k);
    }
    const custom = new Map(
      all<{ category: string; body: string }>(
        db,
        "SELECT category, body FROM agenda_templates WHERE team_id = ?",
        team.id,
      ).map((t) => [t.category, t.body]),
    );
    return c.json({
      policies: teamPolicies(db, team.id).map(view),
      attributes: [...names].sort(),
      templates: Object.fromEntries(
        MEETING_CATEGORIES.map((k) => [
          k,
          { body: custom.get(k) ?? BUILTIN_TEMPLATES[k], custom: custom.has(k) },
        ]),
      ),
    });
  });

  r.post("/policies", async (c) => {
    const { team } = admin(c);
    const body = await jsonBody(c, policyInput);
    const id = randomUUID();
    const t = now();
    run(
      db,
      `INSERT INTO team_policies (id, team_id, type, name, scope, goal, enabled, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      team.id,
      body.type,
      body.name,
      JSON.stringify(body.scope),
      JSON.stringify(goalFor(body.type, body.goal)),
      body.enabled ? 1 : 0,
      body.enabled ? t : null,
      t,
      t,
    );
    replanTeam(team.id);
    const row = one<PolicyRow>(db, "SELECT * FROM team_policies WHERE id = ?", id);
    return c.json({ policy: row ? view(parsePolicy(row)) : null }, 201);
  });

  r.patch("/policies/:id", async (c) => {
    const { team } = admin(c);
    const p = policyOf(c, team.id);
    const body = await jsonBody(c, policyPatch);
    const enabled = body.enabled ?? p.enabled;
    const t = now();
    run(
      db,
      `UPDATE team_policies SET name = ?, scope = ?, goal = ?, enabled = ?, started_at = ?, updated_at = ?
       WHERE id = ?`,
      body.name ?? p.name,
      JSON.stringify(body.scope ?? p.scope),
      JSON.stringify(body.goal ? goalFor(p.type, body.goal) : p.goal),
      enabled ? 1 : 0,
      p.startedAt ?? (enabled ? t : null),
      t,
      p.id,
    );
    replanTeam(team.id);
    const row = one<PolicyRow>(db, "SELECT * FROM team_policies WHERE id = ?", p.id);
    return c.json({ policy: row ? view(parsePolicy(row)) : null });
  });

  r.delete("/policies/:id", (c) => {
    const { team } = admin(c);
    const p = policyOf(c, team.id);
    tx(db, () => {
      removeAutomations(db, p.id);
      run(db, "DELETE FROM team_policies WHERE id = ?", p.id);
    });
    replanTeam(team.id);
    return c.body(null, 204);
  });

  r.put("/policies/templates", async (c) => {
    const { team } = admin(c);
    const { templates } = await jsonBody(
      c,
      z.object({
        templates: z.partialRecord(z.enum(MEETING_CATEGORIES), z.string().max(5000)),
      }),
    );
    tx(db, () => {
      for (const [category, body] of Object.entries(templates)) {
        const text = (body ?? "").trim();
        // An empty or built-in text means "use the built-in template".
        if (!text || text === BUILTIN_TEMPLATES[category as keyof typeof BUILTIN_TEMPLATES]) {
          run(
            db,
            "DELETE FROM agenda_templates WHERE team_id = ? AND category = ?",
            team.id,
            category,
          );
          continue;
        }
        run(
          db,
          `INSERT INTO agenda_templates (team_id, category, body, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (team_id, category) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          team.id,
          category,
          text,
          now(),
        );
      }
    });
    return c.json({ ok: true });
  });

  r.get("/policies/:id/report", (c) => {
    const { team } = admin(c);
    const p = policyOf(c, team.id);
    const groupBy = c.req.query("groupBy")?.trim() || undefined;
    return c.json({
      policy: view(p),
      report: policyReport(db, p, c.get("user").id, now(), groupBy),
    });
  });

  // ------------------------------------------------------------ members
  r.get("/policies/mine", (c) => {
    const user = c.get("user");
    const m = mine(c);
    const links = all<Link & { name: string }>(
      db,
      `SELECT a.*, p.name FROM policy_automations a JOIN team_policies p ON p.id = a.policy_id
       WHERE a.user_id = ?`,
      user.id,
    );
    const values = (l: Link) =>
      l.kind === "focus"
        ? one<{ v: number }>(
            db,
            "SELECT weekly_goal_minutes AS v FROM focus_goals WHERE id = ?",
            l.item_id,
          )?.v
        : l.kind === "buffer"
          ? one<{ v: number }>(
              db,
              "SELECT minutes_before + minutes_after AS v FROM buffers WHERE id = ?",
              l.item_id,
            )?.v
          : one<{ v: number }>(db, "SELECT max_minutes AS v FROM habits WHERE id = ?", l.item_id)
              ?.v;
    const t = now();
    return c.json({
      isAdmin: m.role === "admin",
      policies: [...winningPolicies(db, user.id).values()].map((p) => ({
        ...view(p),
        flexibility: p.type === "fragmentation" ? flexibilityOf(db, p, user.id) : null,
        automations: links
          .filter((l) => l.policy_id === p.id)
          .map((l) => ({
            key: l.key,
            kind: l.kind,
            itemId: l.item_id,
            minutes: values(l) ?? null,
            personalized: l.personalized === 1,
          })),
      })),
      /** Item id -> policy name, for the automation lists (outputs). */
      marks: Object.fromEntries(links.map((l) => [l.item_id, l.name])),
      reminders: remindersOf(db, user.id, m.team.id, t),
      declined: declinedOf(db, user.id, t),
    });
  });

  const myPolicy = (c: Context<AppEnv>): Policy => {
    const p = [...winningPolicies(db, c.get("user").id).values()].find(
      (x) => x.id === c.req.param("id"),
    );
    if (!p) notFound("policy");
    return p;
  };

  // Rules 9 and 12: the member changes a goal or a length; the policy keeps it.
  r.patch("/policies/:id/mine/:key", async (c) => {
    const user = c.get("user");
    const p = myPolicy(c);
    const key = c.req.param("key");
    const d = desiredFor(p).find((x) => x.key === key);
    const link = one<Link>(
      db,
      "SELECT * FROM policy_automations WHERE policy_id = ? AND user_id = ? AND key = ?",
      p.id,
      user.id,
      key,
    );
    if (!d || !link) notFound("automation");
    // Edge case 1: a goal of 0 is the member's choice and stays.
    const { minutes } = await jsonBody(
      c,
      z.object({
        minutes: z
          .number()
          .int()
          .min(0)
          .max(40 * 60)
          .multipleOf(d.kind === "focus" ? 30 : 5),
      }),
    );
    const t = now();
    tx(db, () => {
      if (d.kind === "focus") {
        run(
          db,
          `UPDATE focus_goals SET weekly_goal_minutes = ?, daily_max_minutes = MAX(daily_max_minutes, ?),
             rules_changed_at = ? WHERE id = ? AND user_id = ?`,
          minutes,
          Math.ceil(minutes / 5 / 15) * 15,
          t,
          link.item_id,
          user.id,
        );
      } else if (d.kind === "buffer") {
        run(
          db,
          `UPDATE buffers SET minutes_before = ?, minutes_after = ?, rules_changed_at = ? WHERE id = ? AND user_id = ?`,
          d.side === "before" ? minutes : 0,
          d.side === "after" ? minutes : 0,
          t,
          link.item_id,
          user.id,
        );
      } else {
        run(
          db,
          "UPDATE habits SET min_minutes = ?, max_minutes = ?, rules_changed_at = ? WHERE id = ? AND user_id = ?",
          Math.max(15, minutes),
          Math.max(15, minutes),
          t,
          link.item_id,
          user.id,
        );
      }
      run(
        db,
        "UPDATE policy_automations SET personalized = 1 WHERE policy_id = ? AND user_id = ? AND key = ?",
        p.id,
        user.id,
        key,
      );
    });
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  // Rule 23: the member's flexibility in a fragmentation policy.
  r.put("/policies/:id/mine", async (c) => {
    const user = c.get("user");
    const p = myPolicy(c);
    if (p.type !== "fragmentation") notFound("choice");
    const { flexibility } = await jsonBody(c, z.object({ flexibility: z.enum(FLEXIBILITY) }));
    run(
      db,
      `INSERT INTO policy_choices (policy_id, user_id, choices) VALUES (?, ?, ?)
       ON CONFLICT (policy_id, user_id) DO UPDATE SET choices = excluded.choices`,
      p.id,
      user.id,
      JSON.stringify({ flexibility }),
    );
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ agenda reminders (rules 15, 16)
  const reminder = (c: Context<AppEnv>) => {
    const row = reminderEvent(db, c.get("user").id, c.req.param("id") ?? "");
    if (!row) notFound("reminder");
    return row;
  };
  const setReminder = (id: string, fields: string, ...params: (string | number)[]) =>
    run(
      db,
      `UPDATE agenda_actions SET ${fields}, updated_at = ? WHERE id = ?`,
      ...params,
      now(),
      id,
    );

  r.post("/policies/reminders/:id/agenda", async (c) => {
    const user = c.get("user");
    const row = reminder(c);
    const { text } = await jsonBody(c, z.object({ text: z.string().trim().min(1).max(5000) }));
    const description = row.description ? `${text}\n\n${row.description}` : text;
    await sync.exclusive(user.id, async (pool) => {
      const ev = await pool
        .get(row.account_id)
        .editExternal(row.provider_id, row.event_id, { description }, row.etag);
      cacheEvent(db, row.calendar_id, ev);
    });
    setReminder(row.id, "state = 'resolved'");
    return c.json({ ok: true });
  });

  r.post("/policies/reminders/:id/dismiss", (c) => {
    setReminder(reminder(c).id, "state = 'dismissed'");
    return c.json({ ok: true });
  });

  r.post("/policies/reminders/:id/shorten", async (c) => {
    const user = c.get("user");
    const row = reminder(c);
    const end = row.proposed_end_ms;
    if (row.proposal !== "pending" || end === null) notFound("proposal");
    await sync.exclusive(user.id, async (pool) => {
      const ev = await pool
        .get(row.account_id)
        .editExternal(row.provider_id, row.event_id, { end }, row.etag);
      cacheEvent(db, row.calendar_id, ev);
    });
    setReminder(row.id, "proposal = 'applied', end_ms = ?", end);
    return c.json({ ok: true });
  });

  r.post("/policies/reminders/:id/keep", (c) => {
    const row = reminder(c);
    if (row.proposal !== "pending") notFound("proposal");
    setReminder(row.id, "proposal = 'kept'");
    return c.json({ ok: true });
  });

  return r;
}
