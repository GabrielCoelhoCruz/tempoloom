// SCIM 2.0 Users endpoint (RFC 7643, 7644) for directory provisioning
// (docs/specs/admin-sso-provisioning.md rules 6-8, 11; edge cases 1, 2, 6).
// The identity provider authenticates with the team's bearer token.
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { ensureUser } from "../accounts.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import {
  displayNameOf,
  emailOf,
  flatten,
  isDeactivated,
  type ScimResource,
  setActive,
} from "../directory.ts";
import { joinTeam, membership, TeamError } from "../teams.ts";

const CORE = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const hash = (t: string) => createHash("sha256").update(t).digest("base64url");

type Env = { Variables: { teamId: string } };

interface ProfileRow {
  user_id: string;
  team_id: string;
  external_id: string | null;
  resource: string;
  created_at: number;
  updated_at: number;
}

const scimJson = (c: Context, body: unknown, status = 200) =>
  c.body(JSON.stringify(body), status as 200, { "content-type": "application/scim+json" });

const scimError = (c: Context, status: number, detail: string, scimType?: string) =>
  scimJson(
    c,
    { schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) },
    status,
  );

/** Sets `value` at a SCIM attribute path in the resource (RFC 7644 3.5.2, common forms). */
function setPath(resource: ScimResource, path: string, value: unknown, remove: boolean): void {
  let target = resource as Record<string, unknown>;
  let rest = path;
  const urn = /^(urn:[^ ]+):([^:]+)$/.exec(path);
  if (urn?.[1] && urn[2] && urn[1] !== CORE) {
    target = (resource[urn[1]] ??= {}) as Record<string, unknown>;
    rest = urn[2];
  } else if (urn?.[2]) rest = urn[2];
  // A filter such as emails[type eq "work"].value addresses the first element.
  const parts = rest.replace(/\[[^\]]*\]/g, "[0]").split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i] ?? "";
    if (p.endsWith("[0]")) {
      const list = (target[p.slice(0, -3)] ??= [{}]) as Record<string, unknown>[];
      target = list[0] ??= {};
    } else target = (target[p] ??= {}) as Record<string, unknown>;
  }
  const last = parts.at(-1) ?? "";
  if (remove) delete target[last];
  else target[last] = value;
}

function applyPatch(resource: ScimResource, body: unknown): ScimResource {
  const ops = (body as { Operations?: { op: string; path?: string; value?: unknown }[] })
    .Operations;
  if (!Array.isArray(ops)) throw new Error("Operations missing");
  const next = structuredClone(resource);
  for (const o of ops) {
    const op = o.op.toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") throw new Error(`op ${o.op}`);
    if (o.path) setPath(next, o.path, o.value, op === "remove");
    else if (o.value && typeof o.value === "object") {
      for (const [k, v] of Object.entries(o.value as Record<string, unknown>)) {
        setPath(next, k, v, false);
      }
    }
  }
  return next;
}

/** Active can arrive as a boolean or as the text "False" (some providers). */
const activeOf = (r: ScimResource) => String(r.active ?? "true").toLowerCase() !== "false";

export function scimRoutes(db: Db, baseUrl: string, now: () => number): Hono<Env> {
  const r = new Hono<Env>();

  r.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = /^Bearer (.+)$/i.exec(auth)?.[1];
    const row = token
      ? one<{ team_id: string }>(
          db,
          "SELECT team_id FROM scim_tokens WHERE token_hash = ?",
          hash(token),
        )
      : undefined;
    if (!row) return scimError(c, 401, "A valid bearer token is required.");
    c.set("teamId", row.team_id);
    await next();
  });

  const toScim = (p: ProfileRow) => {
    const resource = JSON.parse(p.resource) as ScimResource;
    return {
      ...resource,
      schemas: resource.schemas ?? [CORE],
      id: p.user_id,
      ...(p.external_id ? { externalId: p.external_id } : {}),
      active: !isDeactivated(db, p.user_id),
      meta: {
        resourceType: "User",
        created: new Date(p.created_at).toISOString(),
        lastModified: new Date(p.updated_at).toISOString(),
        location: new URL(`/scim/v2/Users/${p.user_id}`, baseUrl).toString(),
      },
    };
  };

  const profile = (c: Context<Env>) =>
    one<ProfileRow>(
      db,
      "SELECT * FROM directory_profiles WHERE user_id = ? AND team_id = ?",
      c.req.param("id") ?? "",
      c.get("teamId"),
    );

  /** Stores the resource and applies active (rules 6, 7; edge case 1). */
  const save = (teamId: string, userId: string, resource: ScimResource, externalId?: unknown) => {
    const { id: _id, meta: _meta, ...stored } = resource;
    run(
      db,
      `UPDATE directory_profiles SET resource = ?, attributes = ?, external_id = COALESCE(?, external_id), updated_at = ?
       WHERE user_id = ?`,
      JSON.stringify(stored),
      JSON.stringify(flatten(stored)),
      externalId === undefined ? null : String(externalId),
      now(),
      userId,
    );
    setActive(db, userId, teamId, activeOf(resource), now());
  };

  r.get("/ServiceProviderConfig", (c) =>
    scimJson(c, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { type: "oauthbearertoken", name: "Bearer token", description: "Team SCIM token" },
      ],
    }),
  );

  r.get("/ResourceTypes", (c) =>
    scimJson(c, {
      schemas: [LIST],
      totalResults: 1,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: CORE,
        },
      ],
    }),
  );

  r.get("/Users", (c) => {
    const filter = c.req.query("filter") ?? "";
    const m = /^(userName|externalId|emails\.value)\s+eq\s+"([^"]*)"$/i.exec(filter.trim());
    if (filter && !m)
      return scimError(c, 400, "Only 'eq' filters on userName or externalId.", "invalidFilter");
    const start = Math.max(1, Number(c.req.query("startIndex") ?? 1) || 1);
    const count = Math.min(200, Math.max(0, Number(c.req.query("count") ?? 100) || 100));
    let rows = all<ProfileRow & { email: string }>(
      db,
      `SELECT d.*, u.email FROM directory_profiles d JOIN users u ON u.id = d.user_id
       WHERE d.team_id = ? ORDER BY d.created_at`,
      c.get("teamId"),
    );
    if (m?.[1] && m[2] !== undefined) {
      const value = m[2].toLowerCase();
      rows = rows.filter((p) =>
        m[1]?.toLowerCase() === "externalid"
          ? (p.external_id ?? "").toLowerCase() === value
          : p.email === value,
      );
    }
    return scimJson(c, {
      schemas: [LIST],
      totalResults: rows.length,
      startIndex: start,
      itemsPerPage: Math.min(count, Math.max(0, rows.length - start + 1)),
      Resources: rows.slice(start - 1, start - 1 + count).map(toScim),
    });
  });

  r.get("/Users/:id", (c) => {
    const p = profile(c);
    return p ? scimJson(c, toScim(p)) : scimError(c, 404, "No such user.");
  });

  r.post("/Users", async (c) => {
    const teamId = c.get("teamId");
    const resource = (await c.req.json().catch(() => null)) as ScimResource | null;
    const email = resource ? emailOf(resource) : "";
    if (!resource || !/^[^@\s]+@[^@\s]+$/.test(email))
      return scimError(c, 400, "userName or a primary email is required.", "invalidValue");
    try {
      const userId = tx(db, () => {
        const existing = one<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", email);
        if (
          existing &&
          one(db, "SELECT 1 FROM directory_profiles WHERE user_id = ?", existing.id)
        ) {
          return null;
        }
        // A person who signed up already is adopted into the team (rule 6).
        const user = existing ?? ensureUser(db, email, displayNameOf(resource), now(), teamId);
        if (membership(db, user.id).team.id !== teamId) {
          joinTeam(db, user.id, teamId, "member", now(), undefined);
        }
        run(
          db,
          `INSERT INTO directory_profiles (user_id, team_id, resource, created_at, updated_at)
           VALUES (?, ?, '{}', ?, ?)`,
          user.id,
          teamId,
          now(),
          now(),
        );
        save(teamId, user.id, resource, resource.externalId);
        return user.id;
      });
      if (!userId) return scimError(c, 409, "The user exists.", "uniqueness");
      const p = one<ProfileRow>(db, "SELECT * FROM directory_profiles WHERE user_id = ?", userId);
      return p ? scimJson(c, toScim(p), 201) : scimError(c, 500, "Not saved.");
    } catch (err) {
      if (err instanceof TeamError) {
        return scimError(
          c,
          409,
          err.code === "no_seats"
            ? "The team has no free seats."
            : "The person is the only admin of another team.",
        );
      }
      throw err;
    }
  });

  r.put("/Users/:id", async (c) => {
    const p = profile(c);
    if (!p) return scimError(c, 404, "No such user.");
    const resource = (await c.req.json().catch(() => null)) as ScimResource | null;
    if (!resource) return scimError(c, 400, "Body must be a SCIM User.", "invalidSyntax");
    tx(db, () => save(p.team_id, p.user_id, resource, resource.externalId));
    return scimJson(c, toScim(profile(c) ?? p));
  });

  r.patch("/Users/:id", async (c) => {
    const p = profile(c);
    if (!p) return scimError(c, 404, "No such user.");
    let next: ScimResource;
    try {
      next = applyPatch(
        { ...(JSON.parse(p.resource) as ScimResource), active: !isDeactivated(db, p.user_id) },
        await c.req.json(),
      );
    } catch (err) {
      return scimError(c, 400, String((err as Error).message), "invalidSyntax");
    }
    tx(db, () => save(p.team_id, p.user_id, next, next.externalId));
    return scimJson(c, toScim(profile(c) ?? p));
  });

  // Delete deactivates the person and removes the directory record (edge case 2).
  r.delete("/Users/:id", (c) => {
    const p = profile(c);
    if (!p) return scimError(c, 404, "No such user.");
    tx(db, () => {
      setActive(db, p.user_id, p.team_id, false, now());
      run(db, "DELETE FROM directory_profiles WHERE user_id = ?", p.user_id);
    });
    return c.body(null, 204);
  });

  return r;
}
