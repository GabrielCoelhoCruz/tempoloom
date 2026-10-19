// Organization calendar grant for CalDAV (docs/specs/admin-sso-provisioning.md
// rules 12-15): one CalDAV account that can read every member's calendars.
// Provisioning attaches each person's calendars through it, read-only, with no
// action from the person.

import { upsertAccount } from "./accounts.ts";
import type { SecretBox } from "./crypto.ts";
import { all, type Db, one, run } from "./db.ts";
import { CalDavProvider } from "./providers/caldav.ts";

export interface GrantRow {
  team_id: string;
  server_url: string;
  username: string;
  /** Sealed. */
  password: string;
  home_template: string;
  updated_at: number;
}

export const DEFAULT_HOME_TEMPLATE = "{local}/";

export const grantOf = (db: Db, teamId: string) =>
  one<GrantRow>(db, "SELECT * FROM calendar_grants WHERE team_id = ?", teamId);

/** The person's calendar home: the template, relative to the server URL. */
export function homeUrl(g: { server_url: string; home_template: string }, email: string): string {
  const local = email.slice(0, email.lastIndexOf("@"));
  const path = g.home_template
    .replaceAll("{local}", encodeURIComponent(local))
    .replaceAll("{email}", encodeURIComponent(email));
  return new URL(path, g.server_url).toString();
}

/** A provider that reads one person's calendars with the grant's account. */
export function grantProvider(
  box: SecretBox,
  g: GrantRow,
  person: { email: string; homeUrl: string },
  zone: string,
  now: () => number = Date.now,
): CalDavProvider {
  return new CalDavProvider(
    {
      serverUrl: g.server_url,
      username: g.username,
      password: box.open(g.password),
      email: person.email,
      homeUrl: person.homeUrl,
    },
    zone,
    now,
  );
}

/**
 * Attaches a person's calendars through the team's grant. Returns the new
 * account, or null when there is no grant, the person already has a calendar
 * account, or the grant finds no calendar for them (rule 14).
 */
export async function attachThroughGrant(
  db: Db,
  box: SecretBox,
  teamId: string,
  userId: string,
  now: number,
): Promise<string | null> {
  const g = grantOf(db, teamId);
  const user = one<{ email: string; time_zone: string }>(
    db,
    "SELECT email, time_zone FROM users WHERE id = ? AND deactivated_at IS NULL",
    userId,
  );
  if (!g || !user || one(db, "SELECT 1 FROM accounts WHERE user_id = ?", userId)) return null;
  const home = homeUrl(g, user.email);
  try {
    const calendars = await grantProvider(
      box,
      g,
      { email: user.email, homeUrl: home },
      user.time_zone,
    ).listCalendars();
    if (calendars.length === 0) return null;
  } catch {
    return null;
  }
  const id = upsertAccount(
    db,
    box,
    {
      userId,
      provider: "caldav",
      externalId: `grant|${teamId}|${home}`,
      email: user.email,
      serverUrl: g.server_url,
      credentials: { homeUrl: home },
      isMain: false,
    },
    now,
  );
  run(db, "UPDATE accounts SET grant_team_id = ?, refreshed_at = NULL WHERE id = ?", teamId, id);
  return id;
}

/**
 * Removes grant accounts that the person's own accounts now cover: their own
 * connection reads the same calendars in real time (rule 17), and one calendar
 * must not count twice.
 */
export function dropCoveredGrant(db: Db, userId: string): void {
  for (const a of all<{ id: string }>(
    db,
    `SELECT DISTINCT g.id FROM accounts g JOIN calendars gc ON gc.account_id = g.id
     WHERE g.user_id = ? AND g.grant_team_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM accounts o JOIN calendars oc ON oc.account_id = o.id
       WHERE o.user_id = g.user_id AND o.grant_team_id IS NULL AND oc.provider_id = gc.provider_id)`,
    userId,
  )) {
    run(db, "DELETE FROM accounts WHERE id = ?", a.id);
  }
}
