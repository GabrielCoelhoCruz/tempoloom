// Admin API for provisioning people and calendars (docs/specs/admin-sso-provisioning.md
// rules 10, 12-15, 18): the team's CalDAV calendar grant, and imports of
// people that the worker creates at a paced rate. Team admins only.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, run, tx } from "../db.ts";
import { DEFAULT_HOME_TEMPLATE, grantOf } from "../grant.ts";
import { jsonBody } from "../http.ts";
import { CalDavProvider } from "../providers/caldav.ts";
import { ProviderError } from "../providers/types.ts";
import { enqueue, progress } from "../provisioning.ts";
import { membership } from "../teams.ts";

const MAX_IMPORT = 5000;

const grantBody = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  username: z.string().min(1).max(200),
  /** Empty or missing keeps the saved password. */
  password: z.string().max(1000).optional(),
  homeTemplate: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((t) => t.includes("{local}") || t.includes("{email}"), "Use {local} or {email}")
    .default(DEFAULT_HOME_TEMPLATE),
});

const importBody = z.object({
  people: z
    .array(
      z.object({
        email: z.email(),
        name: z.string().trim().max(200).optional(),
        attributes: z.record(z.string().min(1).max(100), z.string().max(1000)).optional(),
      }),
    )
    .min(1)
    .max(MAX_IMPORT),
});

export function provisioningRoutes(deps: { db: Db; box: SecretBox; now: () => number }) {
  const { db, box, now } = deps;
  const r = new Hono<AppEnv>();
  const adminTeam = (userId: string) => {
    const m = membership(db, userId);
    if (m.role !== "admin") {
      throw new HTTPException(403, {
        res: Response.json({ error: "forbidden" }, { status: 403 }),
      });
    }
    return m.team.id;
  };

  r.get("/team/grant", (c) => {
    const g = grantOf(db, adminTeam(c.get("user").id));
    return c.json({
      serverUrl: g?.server_url ?? "",
      username: g?.username ?? "",
      hasPassword: Boolean(g),
      homeTemplate: g?.home_template ?? DEFAULT_HOME_TEMPLATE,
    });
  });

  r.put("/team/grant", async (c) => {
    const teamId = adminTeam(c.get("user").id);
    const body = await jsonBody(c, grantBody);
    const saved = grantOf(db, teamId);
    const password = body.password || (saved ? box.open(saved.password) : "");
    if (!password) return c.json({ error: "password_required" }, 400);
    try {
      await new CalDavProvider(
        { serverUrl: body.serverUrl, username: body.username, password, email: "" },
        "UTC",
      ).listCalendars();
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") {
        return c.json({ error: "invalid_credentials" }, 400);
      }
      return c.json({ error: "server_unreachable" }, 502);
    }
    tx(db, () => {
      run(
        db,
        `INSERT INTO calendar_grants (team_id, server_url, username, password, home_template, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (team_id) DO UPDATE SET server_url = excluded.server_url,
           username = excluded.username, password = excluded.password,
           home_template = excluded.home_template, updated_at = excluded.updated_at`,
        teamId,
        body.serverUrl,
        body.username,
        box.seal(password),
        body.homeTemplate,
        now(),
      );
      // People provisioned before the grant get their calendars now (rule 12).
      enqueue(
        db,
        teamId,
        all<{ email: string; name: string }>(
          db,
          `SELECT u.email, u.name FROM directory_profiles d JOIN users u ON u.id = d.user_id
           WHERE d.team_id = ? AND u.first_sign_in_at IS NULL AND u.deactivated_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id)`,
          teamId,
        ).map((p) => ({ ...p, attributes: {} })),
        false,
        now(),
      );
    });
    return c.json({ ok: true });
  });

  /** Removes the grant and every calendar attached through it. */
  r.delete("/team/grant", (c) => {
    const teamId = adminTeam(c.get("user").id);
    tx(db, () => {
      run(db, "DELETE FROM accounts WHERE grant_team_id = ?", teamId);
      run(db, "DELETE FROM calendar_grants WHERE team_id = ?", teamId);
    });
    return c.body(null, 204);
  });

  r.get("/team/provisioning", (c) => c.json(progress(db, adminTeam(c.get("user").id))));

  r.post("/team/provisioning", async (c) => {
    const teamId = adminTeam(c.get("user").id);
    const { people } = await jsonBody(c, importBody);
    const unique = new Map(people.map((p) => [p.email.toLowerCase(), p]));
    enqueue(
      db,
      teamId,
      [...unique.values()].map((p) => ({
        email: p.email,
        name: p.name || p.email.slice(0, p.email.indexOf("@")),
        attributes: p.attributes ?? {},
      })),
      true,
      now(),
    );
    return c.json({ queued: unique.size }, 202);
  });

  return r;
}
