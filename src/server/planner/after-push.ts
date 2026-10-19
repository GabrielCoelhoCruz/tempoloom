// Steps after the plan is on the calendars: the done marker on ended habit
// occurrences (habits-automation.md Outputs) and auto-decline of invitations
// that overlap protected focus time (focus-time.md rule 23).
import { DAY } from "../../shared/time.ts";
import { all, type Db, run } from "../db.ts";
import { type CalendarProvider, ProviderError } from "../providers/types.ts";
import type { Settings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import { KEY_PROP, MANAGED_PROP, type ManagedRow } from "./push.ts";

/** Ended occurrences older than this keep their title. */
const DONE_LOOKBACK = 7 * DAY;
export const DEFAULT_DECLINE_MESSAGE = "Declined automatically: this time is protected for focus.";

type Provider = (accountId: string) => CalendarProvider;

export async function afterPush(
  db: Db,
  userId: string,
  settings: Settings,
  provider: Provider,
  now: number,
): Promise<void> {
  await markDone(db, userId, settings, provider, now);
  await autoDecline(db, userId, provider, now);
}

/**
 * Tempoloom decision (start when placed, rule 33): an occurrence is done when
 * its end passes. Its title then carries the done marker in place of the state
 * marker; lock and conflict end with the occurrence.
 */
async function markDone(
  db: Db,
  userId: string,
  settings: Settings,
  provider: Provider,
  now: number,
): Promise<void> {
  const done = settings.markers.done;
  if (!done) return;
  const markers = [...new Set(Object.values(settings.markers).filter(Boolean))];
  const rows = all<
    ManagedRow & { account_id: string; provider_id: string; cached_etag: string | null }
  >(
    db,
    `SELECT m.*, c.account_id, c.provider_id, e.etag AS cached_etag FROM managed_events m
       JOIN calendars c ON c.id = m.calendar_id
       LEFT JOIN events e ON e.calendar_id = m.calendar_id AND e.event_id = m.event_id
     WHERE m.user_id = ? AND m.kind = 'habit' AND m.event_id IS NOT NULL AND m.end_ms <= ? AND m.end_ms > ?`,
    userId,
    now,
    now - DONE_LOOKBACK,
  );
  for (const row of rows) {
    let base = row.title;
    for (const m of markers) if (base.startsWith(`${m} `)) base = base.slice(m.length + 1);
    const title = `${done} ${base}`;
    if (row.title === title || !row.event_id) continue;
    try {
      const ev = await provider(row.account_id).updateEvent(
        row.provider_id,
        row.event_id,
        {
          summary: title,
          description: row.description,
          start: row.start_ms,
          end: row.end_ms,
          busy: row.busy === 1,
          colorId: row.color_id,
          privateProps: { [MANAGED_PROP]: "1", [KEY_PROP]: row.key, tl_user: userId },
        },
        row.cached_etag ?? row.etag,
      );
      cacheEvent(db, row.calendar_id, ev);
      run(db, "UPDATE managed_events SET title = ?, etag = ? WHERE id = ?", title, ev.etag, row.id);
    } catch {
      // A changed or deleted event: the next pull reads it, and the next run tries again.
    }
  }
}

/**
 * Tempoloom decision: auto-decline answers unanswered invitations from other
 * organizers that overlap a placed focus event of an automation with
 * auto-decline on. It never answers the same invitation twice, so the user
 * may accept it again.
 */
async function autoDecline(db: Db, userId: string, provider: Provider, now: number): Promise<void> {
  const sources = new Map(
    all<{ id: string; message: string }>(
      db,
      `SELECT id, decline_message AS message FROM focus_goals WHERE user_id = ? AND enabled = 1 AND decline_enabled = 1
       UNION ALL
       SELECT id, decline_message AS message FROM meeting_overloads WHERE user_id = ? AND enabled = 1 AND decline_enabled = 1`,
      userId,
      userId,
    ).map((s) => [s.id, s.message.trim() || DEFAULT_DECLINE_MESSAGE]),
  );
  if (sources.size === 0) return;
  const blocks = all<{ source_id: string; start_ms: number; end_ms: number }>(
    db,
    "SELECT source_id, start_ms, end_ms FROM managed_events WHERE user_id = ? AND kind = 'focus' AND end_ms > ?",
    userId,
    now,
  ).filter((b) => sources.has(b.source_id));
  if (blocks.length === 0) return;
  const invitations = all<{
    calendar_id: string;
    event_id: string;
    start_ms: number;
    end_ms: number;
    etag: string | null;
    private_props: string;
    account_id: string;
    provider_id: string;
  }>(
    db,
    `SELECT e.calendar_id, e.event_id, e.start_ms, e.end_ms, e.etag, e.private_props, c.account_id, c.provider_id
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1
       AND e.self_response = 'needsAction' AND e.organizer_self = 0 AND e.all_day = 0 AND e.end_ms > ?
       AND NOT EXISTS (SELECT 1 FROM auto_declines d
                       WHERE d.user_id = ? AND d.calendar_id = e.calendar_id AND d.event_id = e.event_id)`,
    userId,
    now,
    userId,
  );
  for (const e of invitations) {
    if ((JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] === "1") continue;
    const block = blocks.find((b) => b.start_ms < e.end_ms && e.start_ms < b.end_ms);
    if (!block) continue;
    try {
      const ev = await provider(e.account_id).editExternal(
        e.provider_id,
        e.event_id,
        { selfResponse: "declined", comment: sources.get(block.source_id) ?? "" },
        e.etag,
      );
      cacheEvent(db, e.calendar_id, ev);
    } catch (err) {
      // A changed invitation is tried again on the next run. Other failures (for
      // example one occurrence of a series on CalDAV) are recorded, so not retried.
      if (err instanceof ProviderError && err.kind === "precondition_failed") continue;
    }
    run(
      db,
      `INSERT OR IGNORE INTO auto_declines (user_id, calendar_id, event_id, source_id, declined_at)
       VALUES (?, ?, ?, ?, ?)`,
      userId,
      e.calendar_id,
      e.event_id,
      block.source_id,
      now,
    );
  }
}
