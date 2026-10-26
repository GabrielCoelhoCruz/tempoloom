// People and attributes that an identity provider pushes over SCIM
// (docs/specs/admin-sso-provisioning.md rules 6-8). Attributes are flat
// name -> text pairs; analytics filters and policy scopes read them.
import { all, type Db, one, run, tx } from "./db.ts";
import { createOwnTeam, isSoleAdmin, joinTeam, membership } from "./teams.ts";

export type Attributes = Record<string, string>;
export type ScimResource = Record<string, unknown>;

const text = (v: unknown): string | undefined =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

/**
 * Flattens a SCIM User: core scalars, every extension's scalars (enterprise,
 * product and custom schemas), and the manager as its SCIM id. Values that are
 * not text are stored as text (edge case 6).
 */
export function flatten(resource: ScimResource): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(resource)) {
    if (key === "schemas" || key === "meta" || key === "id" || key === "externalId") continue;
    if (key.startsWith("urn:") && value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const t =
          text(v) ??
          (v && typeof v === "object" ? text((v as { value?: unknown }).value) : undefined);
        if (t !== undefined && t !== "") out[k] = t;
      }
      continue;
    }
    const t = text(value);
    if (t !== undefined && t !== "") out[key] = t;
  }
  return out;
}

export function emailOf(resource: ScimResource): string {
  const emails = (resource.emails as { value?: string; primary?: boolean }[] | undefined) ?? [];
  const primary = emails.find((e) => e.primary) ?? emails[0];
  return String(primary?.value ?? resource.userName ?? "").toLowerCase();
}

export function displayNameOf(resource: ScimResource): string {
  const name = resource.name as { formatted?: string; givenName?: string; familyName?: string };
  return String(
    resource.displayName ??
      name?.formatted ??
      ([name?.givenName, name?.familyName].filter(Boolean).join(" ") || resource.userName),
  );
}

/** A provisioned person, as the manager attribute can name them. */
export interface ProfileKeys {
  user_id: string;
  external_id: string | null;
  email: string;
}

/**
 * The one rule for the manager attribute (admin-sso-provisioning.md rule 8):
 * it names the manager by SCIM id (the user id), external id or email. Returns
 * a lookup of the given people by those keys.
 */
export function managerLookup<P extends ProfileKeys>(
  people: P[],
): (manager: string) => P | undefined {
  const byKey = new Map<string, P>();
  for (const p of people) {
    byKey.set(p.user_id, p);
    byKey.set(p.email, p);
    if (p.external_id) byKey.set(p.external_id, p);
  }
  return (manager) => byKey.get(manager);
}

/** Attributes of every provisioned member of a team, manager resolved to a name. */
export function directoryAttributes(db: Db, teamId: string): Map<string, Attributes> {
  const rows = all<ProfileKeys & { attributes: string; name: string }>(
    db,
    `SELECT d.user_id, d.external_id, d.attributes, u.name, u.email FROM directory_profiles d
     JOIN users u ON u.id = d.user_id WHERE d.team_id = ?`,
    teamId,
  );
  const manager = managerLookup(rows);
  return new Map(
    rows.map((r) => {
      const a = JSON.parse(r.attributes) as Attributes;
      if (a.manager) a.manager = manager(a.manager)?.name ?? a.manager;
      return [r.user_id, a];
    }),
  );
}

export const isDeactivated = (db: Db, userId: string) =>
  Boolean(one(db, "SELECT 1 FROM users WHERE id = ? AND deactivated_at IS NOT NULL", userId));

/**
 * Applies the directory's `active` flag. Deactivation ends sessions, stops
 * scheduling and frees the seat (edge case 1); the person leaves the team
 * unless they are its only admin. Activation brings them back.
 */
export function setActive(
  db: Db,
  userId: string,
  teamId: string,
  active: boolean,
  now: number,
): void {
  tx(db, () => {
    if (!active) {
      if (isDeactivated(db, userId)) return;
      run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", now, userId);
      run(db, "DELETE FROM sessions WHERE user_id = ?", userId);
      run(db, "DELETE FROM oauth_grants WHERE user_id = ?", userId);
      const m = membership(db, userId);
      if (m.team.id === teamId && !isSoleAdmin(db, userId)) {
        const user = one<{ id: string; name: string; email: string }>(
          db,
          "SELECT id, name, email FROM users WHERE id = ?",
          userId,
        );
        run(db, "DELETE FROM team_members WHERE user_id = ?", userId);
        if (user) createOwnTeam(db, user, now);
      }
      return;
    }
    if (!isDeactivated(db, userId)) return;
    run(db, "UPDATE users SET deactivated_at = NULL WHERE id = ?", userId);
    joinTeam(db, userId, teamId, "member", now, undefined);
  });
}
