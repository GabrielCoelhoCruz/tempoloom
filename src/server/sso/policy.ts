// Sign-in rules for email domains that a team registered for single sign-on
// (docs/specs/admin-sso-provisioning.md rules 2-5, 9; edge cases 3-5).
import { type Db, one } from "../db.ts";
import { domainOf, hasFreeSeat, type Team } from "../teams.ts";

export type SsoMode = "sso_only" | "sso_and_google";

export interface DomainSso {
  teamId: string;
  mode: SsoMode;
  capture: boolean;
}

/** The team whose SSO owns the email's domain, if any. */
export function ssoForEmail(db: Db, email: string): DomainSso | undefined {
  const row = one<{ team_id: string; mode: SsoMode; domain_capture: number }>(
    db,
    `SELECT c.team_id, c.mode, c.domain_capture FROM sso_domains d JOIN sso_configs c ON c.team_id = d.team_id
     WHERE d.domain = ?`,
    domainOf(email),
  );
  return row
    ? { teamId: row.team_id, mode: row.mode, capture: row.domain_capture === 1 }
    : undefined;
}

export type OtherSignIn = { refuse: "sso_required" | "no_seats" } | { teamId?: string };

/**
 * What a sign-in other than SSO (Google, CalDAV) may do for this email.
 * - SSO only: the team's members and new people on its domains must use SSO
 *   (rule 3). People who signed up before, in other teams, keep their sign-in
 *   (rule 2, edge case 4).
 * - SSO and other sign-in: everyone may sign in (rule 4).
 * - With domain capture, a new sign-up joins the team at once (rule 9); an
 *   unregistered domain is never captured (edge case 3).
 */
export function otherSignIn(db: Db, email: string, seatLimit: number | undefined): OtherSignIn {
  const sso = ssoForEmail(db, email);
  if (!sso) return {};
  const user = one<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", email.toLowerCase());
  if (user) {
    const inTeam = one(
      db,
      "SELECT 1 FROM team_members WHERE user_id = ? AND team_id = ?",
      user.id,
      sso.teamId,
    );
    return inTeam && sso.mode === "sso_only" ? { refuse: "sso_required" } : {};
  }
  if (sso.mode === "sso_only") return { refuse: "sso_required" };
  if (!sso.capture) return {};
  const team = one<Team>(db, "SELECT * FROM teams WHERE id = ?", sso.teamId);
  if (!team) return {};
  return hasFreeSeat(db, team, seatLimit) ? { teamId: team.id } : { refuse: "no_seats" };
}
