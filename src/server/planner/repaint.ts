// Repainting (docs/specs/events-categories-and-colors.md rules 8, 10, 12, 16).
// The scheduler run lists the events whose color is wrong; a background job
// writes the colors after the run, so a repaint never delays a run.
import { type Db, one, run } from "../db.ts";
import { OAuthError } from "../google/oauth.ts";
import { type CalendarProvider, ProviderError } from "../providers/types.ts";
import { cacheEvent } from "../sync/pull.ts";

export interface Paint {
  calendarId: string;
  /** The event id, or the series id when `series` is set. */
  eventId: string;
  /** Paint the whole series (external events with the scope "all events"). */
  series: boolean;
  color: string | null;
  /** The managed event whose stored color follows the write. */
  managedId?: string;
}

export interface PaintJob {
  paints: Paint[];
  /** The "repaint all" request this job serves, cleared when every write is done. */
  requestedAt: number | null;
}

export interface PaintContext {
  db: Db;
  provider: (accountId: string) => CalendarProvider;
}

/** Rule 12: asks for a "repaint all"; the next run lists every event and the job clears it. */
export function requestRepaint(db: Db, userId: string, now: number): void {
  run(db, "UPDATE users SET repaint_requested_at = ? WHERE id = ?", now, userId);
}

/** The pending "repaint all" request, or null. */
export function repaintRequest(db: Db, userId: string): number | null {
  return (
    one<{ at: number | null }>(
      db,
      "SELECT repaint_requested_at AS at FROM users WHERE id = ?",
      userId,
    )?.at ?? null
  );
}

/**
 * Writes one paint with the etag of the cached event, the copy that the last
 * read brought (a color changed in the calendar gives a new etag). Returns
 * false when the write must be tried again; events the calendar refuses or
 * that are gone are skipped (rule 10).
 */
export async function writePaint(ctx: PaintContext, p: Paint): Promise<boolean> {
  const { db } = ctx;
  const cal = one<{ account_id: string; provider_id: string }>(
    db,
    "SELECT account_id, provider_id FROM calendars WHERE id = ?",
    p.calendarId,
  );
  if (!cal) return true;
  const cached = p.series
    ? null
    : one<{ etag: string | null; color_id: string | null }>(
        db,
        "SELECT etag, color_id FROM events WHERE calendar_id = ? AND event_id = ?",
        p.calendarId,
        p.eventId,
      );
  const setManaged = (etag?: string | null) =>
    p.managedId &&
    run(
      db,
      `UPDATE managed_events SET color_id = ?, etag = COALESCE(?, etag) WHERE id = ?`,
      p.color,
      etag ?? null,
      p.managedId,
    );
  if (cached && (cached.color_id ?? null) === p.color) {
    setManaged();
    return true;
  }
  try {
    const ev = await ctx
      .provider(cal.account_id)
      .setColor(cal.provider_id, p.eventId, p.color, p.series ? null : (cached?.etag ?? null));
    if (p.series)
      run(
        db,
        "UPDATE events SET color_id = ? WHERE calendar_id = ? AND recurring_id = ?",
        p.color,
        p.calendarId,
        p.eventId,
      );
    else cacheEvent(db, p.calendarId, ev);
    setManaged(ev.etag);
    return true;
  } catch (err) {
    // Refused (rule 10: mail-made events, birthdays), gone, or the account needs
    // a new login: a retry cannot succeed, so it must not hold a "repaint all".
    return (
      err instanceof OAuthError ||
      (err instanceof ProviderError &&
        (err.kind === "auth" || [400, 401, 403, 404, 410].includes(err.status)))
    );
  }
}

/** Ends a job: a "repaint all" request is cleared only when every write is done. */
export function finishPaint(db: Db, userId: string, job: PaintJob, done: boolean): void {
  if (done && job.requestedAt !== null)
    run(
      db,
      "UPDATE users SET repaint_requested_at = NULL WHERE id = ? AND repaint_requested_at = ?",
      userId,
      job.requestedAt,
    );
}

/** Writes the paints of a job in order, then ends it. */
export async function runPaint(ctx: PaintContext, userId: string, job: PaintJob): Promise<void> {
  let done = true;
  for (const p of job.paints) if (!(await writePaint(ctx, p))) done = false;
  finishPaint(ctx.db, userId, job, done);
}
