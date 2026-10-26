// Instance limits (docs/specs/plans-feature-inventory.md rules 2-4). Tempoloom
// has no paid tiers: each limit of the reference plans is an operator setting,
// off by default, set with `node src/server/cli.ts limit` and read on each use,
// so a change applies without a restart.
import { all, type Db, one, run } from "./db.ts";

export const LIMITS = [
  "max_scheduling_window_weeks",
  "max_connected_calendars",
  "max_mirrors",
  "max_booking_links",
  "max_automations_per_user",
  "assistant_chat_quota",
  "max_chat_memories",
] as const;
export type LimitName = (typeof LIMITS)[number];

/** The limit's value, or null when the operator set none. */
export function instanceLimit(db: Db, name: LimitName): number | null {
  const row = one<{ value: string }>(db, "SELECT value FROM instance_settings WHERE key = ?", name);
  return row ? Number(row.value) : null;
}

export function setInstanceLimit(db: Db, name: LimitName, value: number | null): void {
  if (value === null) run(db, "DELETE FROM instance_settings WHERE key = ?", name);
  else
    run(
      db,
      `INSERT INTO instance_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      name,
      String(value),
    );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The message that names a limit and its value (rule 4). */
export function limitMessage(name: LimitName, n: number): string {
  switch (name) {
    case "max_scheduling_window_weeks":
      return `This server plans at most ${plural(n, "week", "weeks")} ahead.`;
    case "max_connected_calendars":
      return `This server allows at most ${plural(n, "connected calendar", "connected calendars")}.`;
    case "max_mirrors":
      return `This server allows at most ${plural(n, "mirroring policy", "mirroring policies")} per person.`;
    case "max_booking_links":
      return `This server allows at most ${plural(n, "booking link", "booking links")} per person.`;
    case "max_automations_per_user":
      return `This server allows at most ${plural(n, "automation", "automations")} (habits, focus time and buffers) per person.`;
    case "assistant_chat_quota":
      return `This server allows ${plural(n, "assistant chat message", "assistant chat messages")} per person per day.`;
    case "max_chat_memories":
      return `This server allows at most ${plural(n, "chat memory", "chat memories")} per person.`;
  }
}

/**
 * The refusal of one more item when `used` items exist, or null when the
 * limit allows it. `issues` lets forms that show validation errors show it.
 */
export function limitRefusal(db: Db, name: LimitName, used: number) {
  const limit = instanceLimit(db, name);
  if (limit === null || used < limit) return null;
  const message = limitMessage(name, limit);
  return { error: "limit_reached", limit: name, message, issues: [{ message }] };
}

/** Habits, focus goals and buffers of a person: the automations that the limit counts. */
export function automationCount(db: Db, userId: string): number {
  return ["habits", "focus_goals", "buffers"].reduce(
    (n, table) =>
      n +
      (one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId)?.n ??
        0),
    0,
  );
}

/**
 * Turns off connected calendars over the limit (plans edge case 1 and the
 * connected-calendar plan limit): the main calendar and the calendars of
 * enabled mirroring policies stay; the others stay in list order until the
 * limit is reached. Returns the number of calendars turned off.
 */
export function enforceCalendarLimit(db: Db, userId: string): number {
  const limit = instanceLimit(db, "max_connected_calendars");
  if (limit === null) return 0;
  const rows = all<{ id: string; locked: number }>(
    db,
    `SELECT c.id,
       (a.is_main = 1 AND c.is_primary = 1) OR EXISTS (SELECT 1 FROM mirror_policies p
         WHERE p.enabled = 1 AND (p.source_calendar_id = c.id OR p.dest_calendar_id = c.id)) AS locked
     FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.grant_team_id IS NULL AND c.check_availability = 1
     ORDER BY locked DESC, a.created_at, c.is_primary DESC, c.name, c.id`,
    userId,
  );
  let off = 0;
  rows.forEach((r, i) => {
    if (i < limit || r.locked) return;
    run(db, "UPDATE calendars SET check_availability = 0 WHERE id = ?", r.id);
    off++;
  });
  return off;
}

/** Connected calendars of a person, as the limit counts them. */
export function connectedCount(db: Db, userId: string): number {
  return (
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND a.grant_team_id IS NULL AND c.check_availability = 1`,
      userId,
    )?.n ?? 0
  );
}
