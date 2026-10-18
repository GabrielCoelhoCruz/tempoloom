// Teams and their members (docs/specs/teams-membership.md). Each user is in
// exactly one team; sign-up creates a team with the user as its admin.
import { randomUUID } from "node:crypto";
import { all, type Db, one, run, tx } from "./db.ts";

export type Role = "admin" | "member";
export type JoinMode = "invite_only" | "request" | "automatic";

export interface Team {
  id: string;
  name: string;
  domain: string;
  join_mode: JoinMode;
  invite_permission: "admins" | "all_members";
  seat_limit: number | null;
  settings: string;
  created_at: number;
}

export interface Membership {
  team: Team;
  role: Role;
}

export class TeamError extends Error {
  readonly code: "sole_admin" | "no_seats" | "not_found";
  constructor(code: TeamError["code"]) {
    super(code);
    this.code = code;
  }
}

/** Mail domains shared by unrelated people: their users are never grouped by domain. */
const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "web.de",
  "fastmail.com",
]);

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
export const isCompanyDomain = (domain: string) => domain !== "" && !PUBLIC_DOMAINS.has(domain);

/** Creates a team with the user as its only member and admin (rule 1). */
export function createOwnTeam(
  db: Db,
  user: { id: string; name: string; email: string },
  now: number,
): string {
  const id = randomUUID();
  run(
    db,
    "INSERT INTO teams (id, name, domain, created_at) VALUES (?, ?, ?, ?)",
    id,
    `${user.name}'s team`,
    domainOf(user.email),
    now,
  );
  run(
    db,
    "INSERT INTO team_members (user_id, team_id, role, joined_at) VALUES (?, ?, 'admin', ?)",
    user.id,
    id,
    now,
  );
  return id;
}

export function membership(db: Db, userId: string): Membership {
  const row = one<Team & { role: Role }>(
    db,
    "SELECT t.*, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?",
    userId,
  );
  if (!row) throw new TeamError("not_found");
  const { role, ...team } = row;
  return { team, role };
}

export const memberCount = (db: Db, teamId: string) =>
  one<{ n: number }>(db, "SELECT count(*) AS n FROM team_members WHERE team_id = ?", teamId)?.n ??
  0;

const adminCount = (db: Db, teamId: string) =>
  one<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM team_members WHERE team_id = ? AND role = 'admin'",
    teamId,
  )?.n ?? 0;

/** The only admin of a team that has other members. */
export function isSoleAdmin(db: Db, userId: string): boolean {
  const { team, role } = membership(db, userId);
  return role === "admin" && adminCount(db, team.id) === 1 && memberCount(db, team.id) > 1;
}

/**
 * Seats in use and the limit. A member uses a seat from the first sign-in, so
 * provisioned people who never signed in use none (rule 26).
 */
export function seats(
  db: Db,
  team: Team,
  instanceLimit: number | undefined,
): { used: number; limit: number | null } {
  const used =
    one<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? AND u.first_sign_in_at IS NOT NULL AND u.deactivated_at IS NULL`,
      team.id,
    )?.n ?? 0;
  return { used, limit: team.seat_limit ?? instanceLimit ?? null };
}

/** False when one more member would go over the seat limit (rule 27). */
export function hasFreeSeat(db: Db, team: Team, instanceLimit: number | undefined): boolean {
  const s = seats(db, team, instanceLimit);
  return s.limit === null || s.used < s.limit;
}

/** Cleanup when a user leaves a team, whichever way they leave. */
function memberLeft(db: Db, teamId: string, userId: string): void {
  run(db, "DELETE FROM team_requests WHERE user_id = ?", userId);
  if (memberCount(db, teamId) === 0) run(db, "DELETE FROM teams WHERE id = ?", teamId);
}

/**
 * Moves a user into a team. The user leaves their current team first; the only
 * admin of a team with other members cannot (rule 18, open question 3).
 */
export function joinTeam(
  db: Db,
  userId: string,
  teamId: string,
  role: Role,
  now: number,
  instanceLimit: number | undefined,
): void {
  tx(db, () => {
    const current = membership(db, userId);
    if (current.team.id === teamId) return;
    const team = one<Team>(db, "SELECT * FROM teams WHERE id = ?", teamId);
    if (!team) throw new TeamError("not_found");
    if (!hasFreeSeat(db, team, instanceLimit)) throw new TeamError("no_seats");
    if (isSoleAdmin(db, userId)) throw new TeamError("sole_admin");
    run(
      db,
      "UPDATE team_members SET team_id = ?, role = ?, joined_at = ? WHERE user_id = ?",
      teamId,
      role,
      now,
      userId,
    );
    memberLeft(db, current.team.id, userId);
  });
}

/** The user leaves and gets a new team of their own; data stays (rules 17-19). */
export function leaveTeam(db: Db, userId: string, now: number): void {
  tx(db, () => {
    const { team } = membership(db, userId);
    if (memberCount(db, team.id) === 1) return;
    if (isSoleAdmin(db, userId)) throw new TeamError("sole_admin");
    const user = one<{ id: string; name: string; email: string }>(
      db,
      "SELECT id, name, email FROM users WHERE id = ?",
      userId,
    );
    if (!user) throw new TeamError("not_found");
    run(db, "DELETE FROM team_members WHERE user_id = ?", userId);
    memberLeft(db, team.id, userId);
    createOwnTeam(db, user, now);
  });
}

export function setRole(db: Db, teamId: string, userId: string, role: Role): void {
  tx(db, () => {
    const m = one<{ role: Role }>(
      db,
      "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
      teamId,
      userId,
    );
    if (!m) throw new TeamError("not_found");
    if (m.role === "admin" && role === "member" && adminCount(db, teamId) === 1) {
      throw new TeamError("sole_admin");
    }
    run(
      db,
      "UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?",
      role,
      teamId,
      userId,
    );
  });
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
}

export const teamMembers = (db: Db, teamId: string) =>
  all<TeamMember>(
    db,
    `SELECT u.id AS userId, u.name, u.email, m.role FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? ORDER BY m.role, u.name, u.email`,
    teamId,
  );

export const sameTeam = (db: Db, a: string, b: string) =>
  Boolean(
    one(
      db,
      `SELECT 1 FROM team_members x JOIN team_members y ON y.team_id = x.team_id
       WHERE x.user_id = ? AND y.user_id = ?`,
      a,
      b,
    ),
  );
