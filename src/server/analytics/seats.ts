// Analytics-only seats (docs/specs/analytics-organization.md open question 4,
// proposed answer): the member's calendar counts in team and organization
// analytics, and the scheduler never changes it. The seat belongs to one team;
// it ends when the member moves to another team.
import { type Db, one, run } from "../db.ts";

export const isAnalyticsOnly = (db: Db, userId: string) =>
  Boolean(
    one(
      db,
      `SELECT 1 FROM analytics_seats s JOIN team_members m ON m.user_id = s.user_id AND m.team_id = s.team_id
       WHERE s.user_id = ?`,
      userId,
    ),
  );

export function setAnalyticsOnly(
  db: Db,
  teamId: string,
  userId: string,
  on: boolean,
  now: number,
): void {
  if (on)
    run(
      db,
      `INSERT INTO analytics_seats (user_id, team_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET team_id = excluded.team_id`,
      userId,
      teamId,
      now,
    );
  else run(db, "DELETE FROM analytics_seats WHERE user_id = ?", userId);
}
