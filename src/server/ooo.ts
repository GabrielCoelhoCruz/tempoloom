// Team out-of-office calendars (docs/specs/teams-ooo-calendar.md): who takes
// part, and the copies of their time away on the shared calendar. Copies are
// written by the owner's sync run, through the owner's account.
import { z } from "zod";
import { addDays, localToUtc, utcToLocal } from "../shared/time.ts";
import { all, type Db, one, run, tx } from "./db.ts";
import { MANAGED_PROP } from "./planner/push.ts";
import { CalDavProvider } from "./providers/caldav.ts";
import type { ProviderPool } from "./providers/index.ts";
import { type EventWrite, ProviderError } from "./providers/types.ts";
import { teamSetting } from "./team-defaults.ts";

/** Team-wide admin settings (spec table "Team-wide admin settings", proposed defaults). */
export const oooSettingsSchema = z.object({
  allowMembers: z.boolean().default(true),
  includeAllDayBusy: z.boolean().default(false),
  partialDayDisplay: z.enum(["exact_times", "all_day"]).default("exact_times"),
});
export type OooSettings = z.infer<typeof oooSettingsSchema>;

export const oooSettings = (db: Db, teamId: string): OooSettings => {
  const parsed = oooSettingsSchema.safeParse(teamSetting(db, teamId, "ooo") ?? {});
  return parsed.success ? parsed.data : oooSettingsSchema.parse({});
};

/** Marks a copy, so it is never read as someone's time away. */
const COPY_PROP = "tl_ooo";
/** The access list is read again after this long, or at once when the team changes (rule 8). */
const ACCESS_TTL = 10 * 60_000;

type Access = "write" | "read" | "none";
const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 };

export interface OooTarget {
  id: string;
  team_id: string;
  owner_id: string;
  calendar_id: string;
  provider_id: string;
  account_id: string;
  access_checked_at: number | null;
}

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/**
 * Reads each team member's access to the target calendar with their own
 * credentials (rules 4, 6, 7). A member is a participant with write access.
 * CalDAV has no groups, so rule 5 does not apply; Google calendar access lists
 * are not read, so a Google target calendar has no participants.
 */
export async function refreshAccess(
  db: Db,
  target: OooTarget,
  pool: ProviderPool,
  now: number,
  force = false,
): Promise<void> {
  const members = all<{ user_id: string }>(
    db,
    "SELECT user_id FROM team_members WHERE team_id = ?",
    target.team_id,
  ).map((m) => m.user_id);
  const known = new Set(
    all<{ user_id: string }>(db, "SELECT user_id FROM ooo_access WHERE ooo_id = ?", target.id).map(
      (a) => a.user_id,
    ),
  );
  const fresh = target.access_checked_at !== null && target.access_checked_at > now - ACCESS_TTL;
  if (!force && fresh && members.length === known.size && members.every((m) => known.has(m)))
    return;
  const access = new Map<string, Access>();
  for (const userId of members) {
    let best: Access = "none";
    for (const a of all<{ id: string; provider: string; server_url: string | null }>(
      db,
      "SELECT id, provider, server_url FROM accounts WHERE user_id = ? AND status = 'ok'",
      userId,
    )) {
      if (a.provider !== "caldav" || !a.server_url || !sameOrigin(a.server_url, target.provider_id))
        continue;
      const provider = pool.get(a.id);
      if (!(provider instanceof CalDavProvider)) continue;
      try {
        const x = await provider.accessTo(target.provider_id);
        if (RANK[x] > RANK[best]) best = x;
      } catch (err) {
        console.error(`out-of-office access check failed for account ${a.id}`, err);
      }
    }
    access.set(userId, best);
  }
  tx(db, () => {
    run(db, "DELETE FROM ooo_access WHERE ooo_id = ?", target.id);
    for (const [userId, a] of access) {
      run(
        db,
        "INSERT INTO ooo_access (ooo_id, user_id, access) VALUES (?, ?, ?)",
        target.id,
        userId,
        a,
      );
    }
    run(db, "UPDATE ooo_calendars SET access_checked_at = ? WHERE id = ?", now, target.id);
  });
}

/** Configurations whose copies this user's run writes: the owner is still in the team (edge case 3). */
export const ownedTargets = (db: Db, ownerId: string) =>
  all<OooTarget>(
    db,
    `SELECT o.id, o.team_id, o.owner_id, o.calendar_id, c.provider_id, c.account_id, o.access_checked_at
     FROM ooo_calendars o JOIN calendars c ON c.id = o.calendar_id
       JOIN accounts a ON a.id = c.account_id AND a.status = 'ok'
       JOIN team_members m ON m.user_id = o.owner_id AND m.team_id = o.team_id
     WHERE o.owner_id = ?`,
    ownerId,
  );

/** Owners whose shared calendars copy this user's time away; they run again when it changes. */
export const oooOwnersOf = (db: Db, userId: string): string[] =>
  all<{ owner_id: string }>(
    db,
    `SELECT DISTINCT o.owner_id FROM ooo_calendars o JOIN ooo_access a ON a.ooo_id = o.id
     WHERE a.user_id = ? AND a.access = 'write' AND o.owner_id <> ?`,
    userId,
    userId,
  ).map((r) => r.owner_id);

interface SourceRow {
  calendar_id: string;
  event_id: string;
  start_ms: number;
  end_ms: number;
  all_day: number;
  busy: number;
  event_type: string;
  self_response: string | null;
  organizer_self: number;
  private_props: string;
}

interface CopyRow {
  source: string;
  mode: "skip" | "exact" | "all_day";
  event_id: string | null;
  written: string;
  source_end_ms: number;
}

/** True when the span covers whole local days in the person's zone. */
function wholeDays(e: SourceRow, zone: string): boolean {
  if (e.all_day === 1) return true;
  const s = utcToLocal(zone, e.start_ms);
  const t = utcToLocal(zone, e.end_ms);
  return s.minuteOfDay === 0 && t.minuteOfDay === 0 && e.end_ms > e.start_ms;
}

/** The copy of one absence (rules 10-13, 15; outputs). */
function copyOf(
  person: { name: string; time_zone: string },
  e: SourceRow,
  mode: "exact" | "all_day",
): EventWrite {
  const zone = person.time_zone;
  const base = {
    summary: `${person.name} out of office`,
    description: `Copied by Tempoloom from ${person.name}'s calendar.`,
    busy: false,
    colorId: null,
    privateProps: { [COPY_PROP]: "1" },
  };
  const full = wholeDays(e, zone);
  if (!full && mode === "exact") return { ...base, start: e.start_ms, end: e.end_ms };
  const start = utcToLocal(zone, e.start_ms).date;
  const end = full
    ? utcToLocal(zone, e.end_ms).date
    : addDays(utcToLocal(zone, e.end_ms - 1).date, 1);
  return {
    ...base,
    start: localToUtc(zone, start, 0),
    end: localToUtc(zone, end, 0),
    allDayDates: { start, end },
  };
}

/**
 * Brings one shared calendar in line with its participants' time away. Each
 * absence is decided when first seen: copied (its display mode fixed then) or
 * skipped. Later setting changes reach only absences seen after them (edge
 * case 6, T3, T6). A copy follows moves and deletes of its source (rule 14).
 * Copies of past absences stay as they are.
 */
export async function syncTarget(
  db: Db,
  target: OooTarget,
  pool: ProviderPool,
  now: number,
): Promise<void> {
  await refreshAccess(db, target, pool, now);
  const settings = oooSettings(db, target.team_id);
  const people = all<{ id: string; name: string; time_zone: string }>(
    db,
    `SELECT u.id, u.name, u.time_zone FROM ooo_access a JOIN users u ON u.id = a.user_id
       JOIN team_members m ON m.user_id = u.id AND m.team_id = ?
     WHERE a.ooo_id = ? AND a.access = 'write' AND u.deactivated_at IS NULL`,
    target.team_id,
    target.id,
  );
  const rows = new Map(
    all<CopyRow>(
      db,
      "SELECT source, mode, event_id, written, source_end_ms FROM ooo_copies WHERE ooo_id = ?",
      target.id,
    ).map((r) => [r.source, r]),
  );
  const provider = pool.get(target.account_id);
  const seen = new Set<string>();
  const save = (source: string, userId: string, r: Omit<CopyRow, "source">) =>
    run(
      db,
      `INSERT INTO ooo_copies (ooo_id, source, user_id, mode, event_id, written, source_end_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ooo_id, source) DO UPDATE SET mode = excluded.mode, event_id = excluded.event_id,
         written = excluded.written, source_end_ms = excluded.source_end_ms`,
      target.id,
      source,
      userId,
      r.mode,
      r.event_id,
      r.written,
      r.source_end_ms,
    );

  for (const person of people) {
    // Time away on the person's own calendars that Tempoloom reads.
    for (const e of all<SourceRow>(
      db,
      `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1 AND c.id <> ? AND e.end_ms > ?`,
      person.id,
      target.calendar_id,
      now,
    )) {
      const props = JSON.parse(e.private_props) as Record<string, string>;
      if (props[MANAGED_PROP] === "1" || props[COPY_PROP] === "1" || e.busy !== 1) continue;
      if (e.self_response === "declined") continue;
      if (e.self_response === "needsAction" && e.organizer_self !== 1) continue;
      const away = e.event_type === "outOfOffice";
      if (!away && e.all_day !== 1) continue;
      const source = `${e.calendar_id}|${e.event_id}`;
      seen.add(source);
      const row = rows.get(source);
      const mode =
        row?.mode ??
        (away
          ? settings.partialDayDisplay === "all_day"
            ? "all_day"
            : "exact"
          : settings.includeAllDayBusy
            ? "all_day"
            : "skip");
      if (mode === "skip") {
        if (!row)
          save(source, person.id, { mode, event_id: null, written: "", source_end_ms: e.end_ms });
        continue;
      }
      const write = copyOf(person, e, mode);
      const written = JSON.stringify([write.summary, write.start, write.end, write.allDayDates]);
      if (row?.event_id && row.written === written) continue;
      let eventId: string;
      try {
        eventId = row?.event_id
          ? (await provider.updateEvent(target.provider_id, row.event_id, write, null)).id
          : (await provider.insertEvent(target.provider_id, write)).id;
      } catch (err) {
        // Someone deleted the copy on the shared calendar: write it again.
        if (!(err instanceof ProviderError && err.kind === "not_found")) throw err;
        eventId = (await provider.insertEvent(target.provider_id, write)).id;
      }
      save(source, person.id, { mode, event_id: eventId, written, source_end_ms: e.end_ms });
    }
  }

  // Absences that are gone, moved out of reach, or of people who stopped taking part.
  for (const [source, row] of rows) {
    if (seen.has(source)) continue;
    if (row.event_id && row.source_end_ms > now)
      await provider.deleteEvent(target.provider_id, row.event_id);
    run(db, "DELETE FROM ooo_copies WHERE ooo_id = ? AND source = ?", target.id, source);
  }
}

/** The owner's run: every shared calendar this user owns. One failure does not stop the others. */
export async function syncOutOfOffice(
  db: Db,
  ownerId: string,
  pool: ProviderPool,
  now: number,
): Promise<void> {
  for (const target of ownedTargets(db, ownerId)) {
    try {
      await syncTarget(db, target, pool, now);
    } catch (err) {
      console.error(`out-of-office copy failed for ${target.id}`, err);
    }
  }
}

/** Deletes the future copies of a configuration before it goes away. */
export async function deleteCopies(
  db: Db,
  oooId: string,
  pool: ProviderPool,
  now: number,
): Promise<void> {
  const target = one<{ provider_id: string; account_id: string }>(
    db,
    `SELECT c.provider_id, c.account_id FROM ooo_calendars o JOIN calendars c ON c.id = o.calendar_id
     WHERE o.id = ?`,
    oooId,
  );
  if (!target) return;
  const provider = pool.get(target.account_id);
  for (const r of all<{ event_id: string }>(
    db,
    "SELECT event_id FROM ooo_copies WHERE ooo_id = ? AND event_id IS NOT NULL AND source_end_ms > ?",
    oooId,
    now,
  )) {
    await provider.deleteEvent(target.provider_id, r.event_id);
  }
}
