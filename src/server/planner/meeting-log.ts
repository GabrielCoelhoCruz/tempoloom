// What happens to flexible meeting occurrences between two plans
// (docs/specs/meetings-flexible-rescheduling.md): calendar edits by the
// organizer, declines (rules 2-3), the instances of adopted series
// (meetings-flexible.md rule 1), and the change log of every move (rules
// 31-32) with the guest update emails it asks for (planning-notifications.md
// NTF-20 to NTF-22).
import { randomUUID } from "node:crypto";
import type { MeetingFrequency } from "../../scheduler/model.ts";
import { meetingAnchor, meetingPeriodStart } from "../../scheduler/plan.ts";
import { addDays, DAY, type LocalDate, localToUtc, utcToLocal } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { getPrefs } from "../meeting-prefs.ts";
import { seriesInstanceDate } from "../meeting-series.ts";
import { getSettings } from "../settings.ts";
import { planningZone } from "../travel.ts";
import type { MeetingRow } from "./meetings.ts";
import type { ManagedRow } from "./push.ts";

export type ChangeReason =
  | "conflict"
  | "declined"
  | "ruleChanged"
  | "noFreeSlot"
  | "manualMove"
  | "manualSkip";

interface Change {
  meetingId: string;
  key: string;
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
  actor: string;
  reason: ChangeReason;
  detail?: string;
  /** Tempoloom wrote this change to the calendar, so guests may hear of it. */
  written: boolean;
}

/** NTF-20 to NTF-22: an email is due when emails are on and the occurrence is near enough. */
function notifyFor(db: Db, userId: string, c: Change, now: number): number {
  if (!c.written) return 0;
  const prefs = getPrefs(db, userId);
  if (!prefs.meetingChangeEmails || prefs.meetingChangeDaysAhead === 0) return 0;
  const starts = [c.oldStart, c.newStart].filter((t): t is number => t !== null);
  if (starts.length === 0) return 0;
  return Math.min(...starts) - now <= prefs.meetingChangeDaysAhead * DAY ? 1 : 0;
}

export function logChange(db: Db, userId: string, c: Change, now: number): void {
  run(
    db,
    `INSERT INTO meeting_changes (user_id, meeting_id, occurrence_key, at, old_start, old_end,
       new_start, new_end, actor, reason, detail, notify) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    c.meetingId,
    c.key,
    now,
    c.oldStart,
    c.oldEnd,
    c.newStart,
    c.newEnd,
    c.actor,
    c.reason,
    c.detail ?? "",
    notifyFor(db, userId, c, now),
  );
}

const meetingOf = (db: Db, id: string) =>
  one<MeetingRow>(db, "SELECT * FROM meetings WHERE id = ?", id);

/** The period of an instance date, as the scheduler counts it; null in a skipped week. */
function periodOf(
  m: MeetingRow,
  date: LocalDate,
  weekStart: 1 | 7,
  zone: string,
): LocalDate | null {
  const anchor = meetingAnchor(zone, { starting: m.starting, createdAt: m.created_at });
  return meetingPeriodStart(JSON.parse(m.frequency) as MeetingFrequency, date, weekStart, anchor);
}

/**
 * Managed rows for the instances of each adopted series in the cache, so the
 * plan moves those instances instead of writing new events. An instance counts
 * in the period of its local date in the planning zone, as the adopt list
 * reads the series' frequency (`seriesInstanceDate`).
 */
function adoptInstances(db: Db, userId: string, now: number): void {
  const settings = getSettings(db, userId);
  const weekStart = settings.weekStart;
  const zone = planningZone(db, userId);
  // Rule 20: instances beyond the planning window keep the series time; they are
  // adopted once the window reaches them, so the plan never drops them.
  const windowEnd = localToUtc(
    zone,
    addDays(utcToLocal(zone, now).date, settings.schedulingWindowWeeks * 7 + 1),
    0,
  );
  for (const m of all<MeetingRow>(
    db,
    "SELECT * FROM meetings WHERE user_id = ? AND enabled = 1 AND series_event_id IS NOT NULL",
    userId,
  )) {
    const instances = all<{
      event_id: string;
      summary: string;
      description: string;
      start_ms: number;
      end_ms: number;
      busy: number;
      etag: string | null;
    }>(
      db,
      `SELECT event_id, summary, description, start_ms, end_ms, busy, etag FROM events
       WHERE calendar_id = ? AND recurring_id = ? AND end_ms > ? AND start_ms < ?`,
      m.series_calendar_id,
      m.series_event_id,
      now,
      windowEnd,
    );
    for (const e of instances) {
      const period = periodOf(m, seriesInstanceDate(zone, e.event_id, e.start_ms), weekStart, zone);
      if (!period) continue;
      const key = `meeting:${m.id}:${period}`;
      if (one(db, "SELECT 1 FROM managed_events WHERE user_id = ? AND key = ?", userId, key))
        continue;
      if (one(db, "SELECT 1 FROM dismissed_keys WHERE user_id = ? AND key = ?", userId, key))
        continue;
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
           start_ms, end_ms, busy, title, description, color_id, locked, etag, extra)
         VALUES (?, ?, ?, ?, ?, 'meeting', ?, ?, ?, ?, ?, ?, NULL, 0, ?, '')`,
        randomUUID(),
        userId,
        m.series_calendar_id,
        e.event_id,
        key,
        m.id,
        e.start_ms,
        e.end_ms,
        e.busy,
        e.summary,
        e.description,
        e.etag,
      );
    }
  }
}

/**
 * Runs after a pull and before the calendar edits are applied: logs the
 * organizer's moves and deletes of occurrences, turns declines of required
 * guests into a move (rules 2-3), and adopts new instances of adopted series.
 */
export function observeMeetings(db: Db, userId: string, calendarIds: string[], now: number): void {
  if (calendarIds.length === 0) return;
  const marks = calendarIds.map(() => "?").join(",");
  const rows = all<ManagedRow>(
    db,
    `SELECT * FROM managed_events WHERE user_id = ? AND kind = 'meeting' AND event_id IS NOT NULL
       AND end_ms > ? AND calendar_id IN (${marks})`,
    userId,
    now,
    ...calendarIds,
  );
  tx(db, () => {
    for (const row of rows) {
      const m = meetingOf(db, row.source_id);
      if (!m || m.user_id !== userId) continue;
      const cached = one<{
        start_ms: number;
        end_ms: number;
        responses: string;
        self_response: string | null;
      }>(
        db,
        "SELECT start_ms, end_ms, responses, self_response FROM events WHERE calendar_id = ? AND event_id = ?",
        row.calendar_id,
        row.event_id,
      );
      const base = { meetingId: m.id, key: row.key, oldStart: row.start_ms, oldEnd: row.end_ms };
      if (!cached) {
        if (row.start_ms > now)
          logChange(
            db,
            userId,
            {
              ...base,
              newStart: null,
              newEnd: null,
              actor: "organizer",
              reason: "manualSkip",
              written: false,
            },
            now,
          );
        continue;
      }
      if (cached.start_ms !== row.start_ms || cached.end_ms !== row.end_ms) {
        logChange(
          db,
          userId,
          {
            ...base,
            newStart: cached.start_ms,
            newEnd: cached.end_ms,
            actor: "organizer",
            reason: "manualMove",
            written: false,
          },
          now,
        );
        continue;
      }
      const responses = JSON.parse(cached.responses) as Record<string, string>;
      const required = all<{ email: string }>(
        db,
        "SELECT email FROM meeting_attendees WHERE meeting_id = ? AND required = 1",
        m.id,
      ).map((a) => a.email);
      const who =
        cached.self_response === "declined"
          ? "organizer"
          : required.find((email) => responses[email] === "declined");
      if (who) decline(db, userId, row, m.id, who, now);
    }
    adoptInstances(db, userId, now);
  });
}

/** Rules 2-3: the declined time is never used again; a lock ends; the move is logged as declined. */
function decline(
  db: Db,
  userId: string,
  row: ManagedRow,
  meetingId: string,
  who: string,
  now: number,
): void {
  const seen = one(
    db,
    `SELECT 1 FROM item_exclusions WHERE user_id = ? AND kind = 'meeting' AND item_id = ?
       AND start_ms = ? AND end_ms = ?`,
    userId,
    meetingId,
    row.start_ms,
    row.end_ms,
  );
  if (seen) return;
  run(
    db,
    "INSERT INTO item_exclusions (user_id, kind, item_id, start_ms, end_ms) VALUES (?, 'meeting', ?, ?, ?)",
    userId,
    meetingId,
    row.start_ms,
    row.end_ms,
  );
  run(db, "UPDATE managed_events SET locked = 0 WHERE id = ?", row.id);
  logChange(
    db,
    userId,
    {
      meetingId,
      key: row.key,
      oldStart: row.start_ms,
      oldEnd: row.end_ms,
      newStart: null,
      newEnd: null,
      actor: who === "organizer" ? "organizer" : "attendee",
      reason: "declined",
      detail: who === "organizer" ? "" : who,
      written: false,
    },
    now,
  );
}

/**
 * Runs after the push: logs each occurrence that the plan moved or removed.
 * A move after a decline completes that decline's entry.
 */
export function recordMeetingChanges(
  db: Db,
  userId: string,
  before: ManagedRow[],
  now: number,
  lastPlannedAt: number,
): void {
  const after = new Map(
    all<ManagedRow>(
      db,
      "SELECT * FROM managed_events WHERE user_id = ? AND kind = 'meeting'",
      userId,
    ).map((r) => [r.key, r]),
  );
  tx(db, () => {
    for (const b of before) {
      if (b.kind !== "meeting" || b.start_ms <= now) continue;
      const m = meetingOf(db, b.source_id);
      if (!m || m.user_id !== userId || m.enabled !== 1) continue;
      const a = after.get(b.key);
      if (a && a.start_ms === b.start_ms && a.end_ms === b.end_ms) continue;
      const pending = one<{ id: number }>(
        db,
        `SELECT id FROM meeting_changes WHERE occurrence_key = ? AND user_id = ? AND reason = 'declined'
           AND new_start IS NULL ORDER BY id DESC LIMIT 1`,
        b.key,
        userId,
      );
      if (a && pending) {
        run(
          db,
          "UPDATE meeting_changes SET new_start = ?, new_end = ?, at = ?, notify = ? WHERE id = ?",
          a.start_ms,
          a.end_ms,
          now,
          notifyFor(
            db,
            userId,
            {
              meetingId: m.id,
              key: b.key,
              oldStart: b.start_ms,
              oldEnd: b.end_ms,
              newStart: a.start_ms,
              newEnd: a.end_ms,
              actor: "attendee",
              reason: "declined",
              written: true,
            },
            now,
          ),
          pending.id,
        );
        continue;
      }
      const skipped = one(
        db,
        "SELECT 1 FROM dismissed_keys WHERE user_id = ? AND key = ?",
        userId,
        b.key,
      );
      logChange(
        db,
        userId,
        {
          meetingId: m.id,
          key: b.key,
          oldStart: b.start_ms,
          oldEnd: b.end_ms,
          newStart: a?.start_ms ?? null,
          newEnd: a?.end_ms ?? null,
          actor: skipped ? "organizer" : "tempoloom",
          reason: a
            ? m.rules_changed_at > lastPlannedAt
              ? "ruleChanged"
              : "conflict"
            : skipped
              ? "manualSkip"
              : "noFreeSlot",
          written: true,
        },
        now,
      );
    }
  });
}
