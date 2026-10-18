// The team page: members, invitations, join requests and team settings
// (docs/specs/teams-membership.md, teams-settings-templates.md rule 12).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import type { SecretBox } from "../crypto.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { directoryAttributes } from "../directory.ts";
import { jsonBody, notFound } from "../http.ts";
import type { Mailer } from "../mail.ts";
import {
  hasFreeSeat,
  isCompanyDomain,
  joinTeam,
  leaveTeam,
  type Membership,
  memberCount,
  membership,
  type Role,
  seats,
  setRole,
  type Team,
  TeamError,
  teamMembers,
} from "../teams.ts";

export interface TeamDeps {
  db: Db;
  box: SecretBox;
  mailer: Mailer;
  baseUrl: string;
  seatLimit: number | undefined;
  now: () => number;
}

const hash = (t: string) => createHash("sha256").update(t).digest("base64url");

interface InviteRow {
  id: string;
  team_id: string;
  email: string;
  token: string;
  grant_admin: number;
  invited_by: string | null;
  state: string;
}

/** Turns domain errors into HTTP answers. */
function fail(err: unknown): never {
  if (err instanceof TeamError) {
    throw new HTTPException(err.code === "not_found" ? 404 : 409, {
      res: Response.json({ error: err.code }, { status: err.code === "not_found" ? 404 : 409 }),
    });
  }
  throw err;
}

const forbidden = (): never => {
  throw new HTTPException(403, { res: Response.json({ error: "forbidden" }, { status: 403 }) });
};

/** Teams this user can find by email domain (rules 12, 13): 2 or more members, not invite only. */
function discoverable(db: Db, userId: string, email: string): Team[] {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!isCompanyDomain(domain)) return [];
  return all<Team>(
    db,
    `SELECT t.* FROM teams t WHERE t.domain = ? AND t.join_mode <> 'invite_only'
       AND (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) >= 2
       AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?)
     ORDER BY t.created_at`,
    domain,
    userId,
  );
}

export function teamRoutes(deps: TeamDeps): Hono<AppEnv> {
  const { db, box, mailer, baseUrl, now } = deps;
  const r = new Hono<AppEnv>();
  const mine = (c: Context<AppEnv>): Membership => membership(db, c.get("user").id);
  const admin = (c: Context<AppEnv>): Membership => {
    const m = mine(c);
    if (m.role !== "admin") forbidden();
    return m;
  };
  const linkOf = (token: string) => new URL(`/join/${token}`, baseUrl).toString();

  r.get("/team", (c) => {
    const user = c.get("user");
    const { team, role } = mine(c);
    const alone = memberCount(db, team.id) === 1;
    const s = seats(db, team, deps.seatLimit);
    const invites = all<{ id: string; email: string; invited_by: string | null }>(
      db,
      "SELECT id, email, invited_by FROM team_invites WHERE team_id = ? AND state = 'pending' ORDER BY created_at",
      team.id,
    );
    const requests =
      role === "admin"
        ? all<{ userId: string; name: string; email: string }>(
            db,
            `SELECT u.id AS userId, u.name, u.email FROM team_requests q JOIN users u ON u.id = q.user_id
             WHERE q.team_id = ? ORDER BY q.created_at`,
            team.id,
          )
        : [];
    const domain = user.email.slice(user.email.lastIndexOf("@") + 1);
    // Rule 2: same-domain users who are not in a team with others, offered for a new team.
    const colleagues =
      alone && isCompanyDomain(domain)
        ? all<{ email: string; name: string }>(
            db,
            `SELECT u.email, u.name FROM users u JOIN team_members m ON m.user_id = u.id
             WHERE u.email LIKE ? AND u.id <> ?
               AND (SELECT count(*) FROM team_members x WHERE x.team_id = m.team_id) = 1
             ORDER BY u.email`,
            `%@${domain}`,
            user.id,
          )
        : [];
    const requested = new Set(
      all<{ team_id: string }>(
        db,
        "SELECT team_id FROM team_requests WHERE user_id = ?",
        user.id,
      ).map((x) => x.team_id),
    );
    return c.json({
      team: {
        id: team.id,
        name: team.name,
        joinMode: team.join_mode,
        invitePermission: team.invite_permission,
      },
      role,
      members: teamMembers(db, team.id),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        canManage: role === "admin" || i.invited_by === user.id,
      })),
      requests,
      seats: s,
      overage: s.limit !== null && s.used > s.limit,
      canInvite: role === "admin" || team.invite_permission === "all_members",
      mailConfigured: mailer.configured,
      prompts: {
        colleagues,
        teams: alone
          ? discoverable(db, user.id, user.email).map((t) => ({
              id: t.id,
              name: t.name,
              joinMode: t.join_mode,
              requested: requested.has(t.id),
            }))
          : [],
      },
    });
  });

  r.patch("/team", async (c) => {
    const { team } = admin(c);
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        joinMode: z.enum(["invite_only", "request", "automatic"]).optional(),
        invitePermission: z.enum(["admins", "all_members"]).optional(),
      }),
    );
    run(
      db,
      "UPDATE teams SET name = ?, join_mode = ?, invite_permission = ? WHERE id = ?",
      body.name ?? team.name,
      body.joinMode ?? team.join_mode,
      body.invitePermission ?? team.invite_permission,
      team.id,
    );
    return c.json({ ok: true });
  });

  r.post("/team/invites", async (c) => {
    const user = c.get("user");
    const { team, role } = mine(c);
    if (role !== "admin" && team.invite_permission !== "all_members") forbidden();
    const body = await jsonBody(
      c,
      z.object({
        emails: z.array(z.email()).min(1).max(50),
        message: z.string().max(2000).optional(),
        admin: z.boolean().optional(),
      }),
    );
    if (body.admin && role !== "admin") forbidden();
    if (!hasFreeSeat(db, team, deps.seatLimit)) return c.json({ error: "no_seats" }, 409);
    const refused: { email: string; reason: string }[] = [];
    const created: { email: string; token: string }[] = [];
    for (const raw of new Set(body.emails.map((e) => e.toLowerCase()))) {
      if (
        one(
          db,
          `SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.email = ?`,
          team.id,
          raw,
        )
      ) {
        refused.push({ email: raw, reason: "already_member" });
        continue;
      }
      const token = randomBytes(24).toString("base64url");
      tx(db, () => {
        // A new invitation replaces a pending one for the same address.
        run(
          db,
          "UPDATE team_invites SET state = 'revoked' WHERE team_id = ? AND email = ? AND state = 'pending'",
          team.id,
          raw,
        );
        run(
          db,
          `INSERT INTO team_invites (id, team_id, email, message, grant_admin, token, token_hash, invited_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(),
          team.id,
          raw,
          body.message ?? "",
          body.admin ? 1 : 0,
          box.seal(token),
          hash(token),
          user.id,
          now(),
        );
      });
      created.push({ email: raw, token });
    }
    const unsent: string[] = [];
    if (mailer.configured) {
      for (const inv of created) {
        try {
          await mailer.send({
            to: inv.email,
            subject: `${user.name} invited you to ${team.name} on Tempoloom`,
            text: [
              `${user.name} (${user.email}) invited you to join ${team.name} on Tempoloom.`,
              body.message ?? "",
              `Join the team: ${linkOf(inv.token)}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          });
        } catch (err) {
          console.error("invitation email failed", err);
          unsent.push(inv.email);
        }
      }
    }
    return c.json({
      sent: mailer.configured ? created.map((i) => i.email).filter((e) => !unsent.includes(e)) : [],
      created: created.map((i) => i.email),
      unsent,
      refused,
    });
  });

  const managedInvite = (c: Context<AppEnv>): InviteRow => {
    const { team, role } = mine(c);
    const inv = one<InviteRow>(
      db,
      "SELECT * FROM team_invites WHERE id = ? AND team_id = ? AND state = 'pending'",
      c.req.param("id") ?? "",
      team.id,
    );
    if (!inv) notFound("invite");
    if (role !== "admin" && inv.invited_by !== c.get("user").id) forbidden();
    return inv;
  };

  r.post("/team/invites/:id/link", (c) => {
    const inv = managedInvite(c);
    return c.json({ url: linkOf(box.open(inv.token)) });
  });

  r.delete("/team/invites/:id", (c) => {
    const inv = managedInvite(c);
    run(db, "UPDATE team_invites SET state = 'revoked' WHERE id = ?", inv.id);
    return c.body(null, 204);
  });

  r.post("/team/invites/accept", async (c) => {
    const { token } = await jsonBody(c, z.object({ token: z.string().min(1).max(200) }));
    const inv = one<InviteRow>(
      db,
      "SELECT * FROM team_invites WHERE token_hash = ? AND state = 'pending'",
      hash(token),
    );
    if (!inv) return c.json({ error: "invalid_invite" }, 410);
    try {
      tx(db, () => {
        joinTeam(
          db,
          c.get("user").id,
          inv.team_id,
          inv.grant_admin ? "admin" : "member",
          now(),
          deps.seatLimit,
        );
        run(db, "UPDATE team_invites SET state = 'accepted' WHERE id = ?", inv.id);
      });
    } catch (err) {
      fail(err);
    }
    return c.json({ ok: true });
  });

  const findable = (c: Context<AppEnv>, teamId: string) => {
    const user = c.get("user");
    const t = discoverable(db, user.id, user.email).find((x) => x.id === teamId);
    if (!t) notFound("team");
    return t;
  };

  r.post("/team/requests", async (c) => {
    const { teamId } = await jsonBody(c, z.object({ teamId: z.string() }));
    const t = findable(c, teamId);
    if (t.join_mode !== "request") return c.json({ error: "wrong_join_mode" }, 409);
    run(
      db,
      "INSERT OR IGNORE INTO team_requests (team_id, user_id, created_at) VALUES (?, ?, ?)",
      t.id,
      c.get("user").id,
      now(),
    );
    return c.json({ ok: true });
  });

  r.post("/team/join", async (c) => {
    const { teamId } = await jsonBody(c, z.object({ teamId: z.string() }));
    const t = findable(c, teamId);
    if (t.join_mode !== "automatic") return c.json({ error: "wrong_join_mode" }, 409);
    try {
      joinTeam(db, c.get("user").id, t.id, "member", now(), deps.seatLimit);
    } catch (err) {
      fail(err);
    }
    return c.json({ ok: true });
  });

  // The first admin to answer a request wins; the second sees it as resolved (edge case 6).
  const resolve = (c: Context<AppEnv>, then: (teamId: string, userId: string) => void) => {
    const { team } = admin(c);
    const userId = c.req.param("userId") ?? "";
    try {
      tx(db, () => {
        if (
          !one(db, "SELECT 1 FROM team_requests WHERE team_id = ? AND user_id = ?", team.id, userId)
        )
          throw new HTTPException(409, {
            res: Response.json({ error: "request_resolved" }, { status: 409 }),
          });
        run(db, "DELETE FROM team_requests WHERE team_id = ? AND user_id = ?", team.id, userId);
        then(team.id, userId);
      });
    } catch (err) {
      fail(err);
    }
    return c.json({ ok: true });
  };

  r.post("/team/requests/:userId/approve", async (c) => {
    const { admin: asAdmin } = await jsonBody(c, z.object({ admin: z.boolean().optional() }));
    return resolve(c, (teamId, userId) =>
      joinTeam(db, userId, teamId, asAdmin ? "admin" : "member", now(), deps.seatLimit),
    );
  });

  r.post("/team/requests/:userId/reject", (c) => resolve(c, () => {}));

  r.post("/team/leave", (c) => {
    try {
      leaveTeam(db, c.get("user").id, now());
    } catch (err) {
      fail(err);
    }
    return c.json({ ok: true });
  });

  const target = (c: Context<AppEnv>, teamId: string) => {
    const userId = c.req.param("userId") ?? "";
    if (!one(db, "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?", teamId, userId))
      notFound("member");
    return userId;
  };

  r.patch("/team/members/:userId", async (c) => {
    const { team } = admin(c);
    const { role } = await jsonBody(c, z.object({ role: z.enum(["admin", "member"]) }));
    try {
      setRole(db, team.id, target(c, team.id), role as Role);
    } catch (err) {
      fail(err);
    }
    return c.json({ ok: true });
  });

  r.delete("/team/members/:userId", (c) => {
    const { team } = admin(c);
    try {
      leaveTeam(db, target(c, team.id), now());
    } catch (err) {
      fail(err);
    }
    return c.body(null, 204);
  });

  // Directory provisioning: the SCIM token and the admin view (admin-sso-provisioning.md outputs).
  r.post("/team/scim-token", (c) => {
    const { team } = admin(c);
    const token = randomBytes(32).toString("base64url");
    run(
      db,
      `INSERT INTO scim_tokens (team_id, token_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT (team_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
      team.id,
      hash(token),
      now(),
    );
    return c.json({ token, baseUrl: new URL("/scim/v2", baseUrl).toString() });
  });

  r.get("/team/directory", (c) => {
    const { team } = admin(c);
    const attributes = directoryAttributes(db, team.id);
    const people = all<{
      user_id: string;
      email: string;
      name: string;
      first_sign_in_at: number | null;
      deactivated_at: number | null;
      calendars: number;
      events_read: number;
      last_read: number | null;
    }>(
      db,
      `SELECT d.user_id, u.email, u.name, u.first_sign_in_at, u.deactivated_at,
         (SELECT count(*) FROM accounts a WHERE a.user_id = u.id AND a.status = 'ok') AS calendars,
         (SELECT count(*) FROM events e JOIN calendars c ON c.id = e.calendar_id
            JOIN accounts a ON a.id = c.account_id
          WHERE a.user_id = u.id AND a.status = 'ok' AND c.check_availability = 1
            AND json_extract(e.private_props, '$.tl') IS NOT '1') AS events_read,
         (SELECT max(c.synced_at) FROM calendars c JOIN accounts a ON a.id = c.account_id
          WHERE a.user_id = u.id AND a.status = 'ok') AS last_read
       FROM directory_profiles d JOIN users u ON u.id = d.user_id WHERE d.team_id = ? ORDER BY u.email`,
      team.id,
    );
    return c.json({
      hasToken: Boolean(one(db, "SELECT 1 FROM scim_tokens WHERE team_id = ?", team.id)),
      people: people.map((p) => {
        const { userName: _u, displayName: _d, ...shown } = attributes.get(p.user_id) ?? {};
        return {
          email: p.email,
          name: p.name,
          attributes: shown,
          signedIn: p.first_sign_in_at !== null,
          seat: p.first_sign_in_at !== null && p.deactivated_at === null,
          calendar: p.calendars > 0,
          eventsRead: p.events_read,
          lastRead: p.last_read,
          deactivated: p.deactivated_at !== null,
        };
      }),
    });
  });

  return r;
}

/** The public view of an invitation link: no session needed. */
export function publicInviteRoutes(db: Db): Hono {
  const r = new Hono();
  r.get("/invites/:token", (c) => {
    const inv = one<{ team: string; inviter: string | null }>(
      db,
      `SELECT t.name AS team, u.name AS inviter FROM team_invites i JOIN teams t ON t.id = i.team_id
       LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ? AND i.state = 'pending'`,
      hash(c.req.param("token")),
    );
    return c.json(inv ? { valid: true, ...inv } : { valid: false });
  });
  return r;
}
