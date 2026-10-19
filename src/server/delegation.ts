// Delegated access (docs/specs/accounts-delegated-access.md): an owner lets a
// member of the same team (the delegate) act inside the owner's account. The
// delegate's session then carries the owner as the acting user.
import { hashToken, type User, userForSession } from "./accounts.ts";
import { all, type Db, one, run } from "./db.ts";
import { membership, sameTeam } from "./teams.ts";

export interface Person {
  id: string;
  name: string;
  email: string;
}

export class DelegationError extends Error {
  readonly code: "not_in_team";
  constructor(code: DelegationError["code"]) {
    super(code);
    this.code = code;
  }
}

/** A grant exists, both are in one team and the owner is active (rule 3; edge cases 1, 2). */
export function canAct(db: Db, delegateId: string, ownerId: string): boolean {
  return (
    Boolean(
      one(
        db,
        `SELECT 1 FROM delegates d JOIN users o ON o.id = d.owner_id
         WHERE d.owner_id = ? AND d.delegate_id = ? AND o.deactivated_at IS NULL`,
        ownerId,
        delegateId,
      ),
    ) && sameTeam(db, ownerId, delegateId)
  );
}

export const delegatesOf = (db: Db, ownerId: string) =>
  all<Person>(
    db,
    `SELECT u.id, u.name, u.email FROM delegates d JOIN users u ON u.id = d.delegate_id
     WHERE d.owner_id = ? ORDER BY u.name, u.email`,
    ownerId,
  );

/** Owners whose accounts the person may act in: the account menu (rule 5). */
export const ownersOf = (db: Db, delegateId: string) =>
  all<Person>(
    db,
    `SELECT u.id, u.name, u.email FROM delegates d JOIN users u ON u.id = d.owner_id
     JOIN team_members a ON a.user_id = d.owner_id
     JOIN team_members b ON b.user_id = d.delegate_id AND b.team_id = a.team_id
     WHERE d.delegate_id = ? AND u.deactivated_at IS NULL ORDER BY u.name, u.email`,
    delegateId,
  );

/** Team members who match `q` and are not yet delegates of the owner (rules 1, 3). */
export function candidates(db: Db, ownerId: string, q: string): Person[] {
  const like = `%${q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
  return all<Person>(
    db,
    `SELECT u.id, u.name, u.email FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND u.id <> ? AND u.deactivated_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM delegates d WHERE d.owner_id = ? AND d.delegate_id = u.id)
       AND (lower(u.name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\')
     ORDER BY u.name, u.email LIMIT 20`,
    membership(db, ownerId).team.id,
    ownerId,
    ownerId,
    like,
    like,
  );
}

export function grant(db: Db, ownerId: string, delegateId: string, now: number): void {
  if (delegateId === ownerId || !sameTeam(db, ownerId, delegateId))
    throw new DelegationError("not_in_team");
  run(
    db,
    "INSERT INTO delegates (owner_id, delegate_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ownerId,
    delegateId,
    now,
  );
}

/** Open acting sessions end at their next request (rule 10). */
export function revoke(db: Db, ownerId: string, delegateId: string): void {
  run(db, "DELETE FROM delegates WHERE owner_id = ? AND delegate_id = ?", ownerId, delegateId);
}

export interface Identity {
  /** Whose data the request works on: the owner in an acting session. */
  user: User;
  /** The person behind the session while they act for `user`. */
  actor?: User;
  /** Hash of the session token. */
  session: string;
}

/**
 * The identity of a session cookie. An acting session whose access ended goes
 * back to the delegate's own account and reports "acting_ended" once (rule 10).
 */
export function sessionIdentity(
  db: Db,
  token: string,
  now: number,
): Identity | "acting_ended" | undefined {
  const me = userForSession(db, token, now);
  if (!me) return undefined;
  const session = hashToken(token);
  const ownerId = one<{ acting_as: string | null }>(
    db,
    "SELECT acting_as FROM sessions WHERE token_hash = ?",
    session,
  )?.acting_as;
  if (!ownerId) return { user: me, session };
  const owner = canAct(db, me.id, ownerId)
    ? one<User>(db, "SELECT id, email, name, time_zone FROM users WHERE id = ?", ownerId)
    : undefined;
  if (owner) return { user: owner, actor: me, session };
  setActing(db, session, null);
  return "acting_ended";
}

export function setActing(db: Db, session: string, ownerId: string | null): void {
  run(db, "UPDATE sessions SET acting_as = ? WHERE token_hash = ?", ownerId, session);
}

/**
 * Rule 7, plus open question 3: what stays with the owner. Returns the message
 * for a blocked request, or undefined.
 */
export function blockedForDelegate(
  method: string,
  path: string,
  owner: string,
): string | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  if (
    /^\/api\/(accounts|holiday-feeds)(\/|$)/.test(path) ||
    /^\/api\/calendars\/(?!refresh$)[^/]+$/.test(path)
  )
    return `Delegates cannot add or remove accounts or calendars. Ask ${owner} to do it.`;
  if (/^\/api\/keys(\/|$)/.test(path))
    return `Delegates cannot create or change API keys. Ask ${owner} to do it.`;
  if (method === "DELETE" && path === "/api/me")
    return `Delegates cannot delete ${owner}'s account.`;
  if (/^\/api\/delegates(\/|$)/.test(path)) return `Only ${owner} can change delegated access.`;
  if (/^\/api\/team(\/|$)/.test(path)) return `Delegates cannot change ${owner}'s team.`;
  // Team-wide admin settings: policies, agenda templates, salaries, analytics seats, webhooks.
  if (/^\/api\/(policies(\/templates|\/[^/]+)?|analytics\/.*|webhooks(\/.*)?)$/.test(path))
    return `Delegates cannot change ${owner}'s team settings.`;
  return undefined;
}

/** Rule 11: the owner sees who changed what in an acting session. */
export function recordChange(
  db: Db,
  ownerId: string,
  actorEmail: string,
  method: string,
  path: string,
  now: number,
): void {
  run(
    db,
    "INSERT INTO delegate_changes (owner_id, actor_email, method, path, created_at) VALUES (?, ?, ?, ?, ?)",
    ownerId,
    actorEmail,
    method,
    path,
    now,
  );
}

const NOUNS: Record<string, string> = {
  tasks: "a task",
  habits: "a habit",
  meetings: "a flexible meeting",
  buffers: "a buffer",
  focus: "focus time",
  hours: "hours",
  settings: "settings",
  mirrors: "a mirroring policy",
  booking: "a booking link",
  webhooks: "a webhook",
  planner: "the planner",
  me: "the profile",
};

/** "added a task", "changed settings": a reading of the request for the owner. */
function describe(method: string, path: string): string {
  const parts = path.split("/").filter(Boolean);
  const noun = NOUNS[parts[1] ?? ""] ?? parts.slice(1).join("/");
  const verb =
    method === "POST" && parts.length === 2 ? "added" : method === "DELETE" ? "deleted" : "changed";
  return `${verb} ${noun}`;
}

export const changesFor = (db: Db, ownerId: string) =>
  all<{ actor_email: string; method: string; path: string; created_at: number }>(
    db,
    `SELECT actor_email, method, path, created_at FROM delegate_changes WHERE owner_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 50`,
    ownerId,
  ).map((c) => ({ actor: c.actor_email, change: describe(c.method, c.path), at: c.created_at }));
