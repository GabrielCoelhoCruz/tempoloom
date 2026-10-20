// Steps after the plan is on the calendars: auto-decline of invitations that
// overlap protected focus time (focus-time.md rule 23) and the #tl_busy quick
// block (events-tags.md rule 14). The done marker on
// ended occurrences is markEnded in markers.ts.
import { TAG_BUSY } from "../../scheduler/blocking.ts";
import { all, type Db, run } from "../db.ts";
import { type CalendarProvider, ProviderError } from "../providers/types.ts";
import { cacheEvent } from "../sync/pull.ts";
import { MANAGED_PROP } from "./push.ts";

export const DEFAULT_DECLINE_MESSAGE = "Declined automatically: this time is protected for focus.";

type Provider = (accountId: string) => CalendarProvider;

export async function afterPush(
  db: Db,
  userId: string,
  provider: Provider,
  now: number,
): Promise<void> {
  await autoDecline(db, userId, provider, now);
  await quickBlock(db, userId, provider, now);
}

/**
 * events-tags.md rule 14: a busy event the user made whose whole title is
 * `#tl_busy` becomes free, so others see the time as open while tasks and
 * habits stay out of it (rule 12). One occurrence of a series is not edited.
 */
async function quickBlock(db: Db, userId: string, provider: Provider, now: number): Promise<void> {
  const rows = all<{
    calendar_id: string;
    event_id: string;
    etag: string | null;
    private_props: string;
    account_id: string;
    provider_id: string;
  }>(
    db,
    `SELECT e.calendar_id, e.event_id, e.etag, e.private_props, c.account_id, c.provider_id
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.writable = 1 AND e.busy = 1 AND e.end_ms > ?
       AND e.organizer_self = 1 AND e.recurring_id IS NULL AND lower(trim(e.summary)) = ?`,
    userId,
    now,
    TAG_BUSY,
  );
  for (const e of rows) {
    if ((JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] === "1") continue;
    try {
      const ev = await provider(e.account_id).editExternal(
        e.provider_id,
        e.event_id,
        { busy: false },
        e.etag,
      );
      cacheEvent(db, e.calendar_id, ev);
    } catch {
      // The event changed or the calendar refused: the next run tries again.
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
    organizer_email: string;
  }>(
    db,
    `SELECT e.calendar_id, e.event_id, e.start_ms, e.end_ms, e.etag, e.private_props, c.account_id, c.provider_id,
       e.organizer_email
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1
       AND e.self_response = 'needsAction' AND e.organizer_self = 0 AND e.all_day = 0 AND e.end_ms > ?
       AND NOT EXISTS (SELECT 1 FROM auto_declines d
                       WHERE d.user_id = ? AND d.calendar_id = e.calendar_id AND d.event_id = e.event_id)`,
    userId,
    now,
    userId,
  );
  // The user's own meeting seen from another account or calendar of the user
  // (Google: no organizer.self on that copy) is not an invitation from others.
  const own = ownAddresses(db, userId);
  for (const e of invitations) {
    if ((JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] === "1") continue;
    if (own.has(e.organizer_email.toLowerCase())) continue;
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

/** Every address of the user: sign-in email, account emails and calendar ids. */
function ownAddresses(db: Db, userId: string): Set<string> {
  return new Set(
    all<{ address: string }>(
      db,
      `SELECT email AS address FROM users WHERE id = ?
       UNION SELECT email FROM accounts WHERE user_id = ?
       UNION SELECT c.provider_id FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ?`,
      userId,
      userId,
      userId,
    )
      .map((r) => r.address.toLowerCase())
      .filter(Boolean),
  );
}
