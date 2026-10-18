// Meeting agenda policy (docs/specs/teams-policies.md rules 14-19): finds
// meetings in scope without an agenda, reminds organizers with a draft from
// the meeting type's template, proposes a shorter meeting ("adjust"), and
// declines invitations at the lead time ("auto_decline"). Tempoloom has no AI
// drafting: a draft is the team's template for the meeting type.
import { randomUUID } from "node:crypto";
import { DAY, MINUTE } from "../../shared/time.ts";
import { all, type Db, one, run } from "../db.ts";
import { type CachedEvent, categoryContext, externalCategory } from "../planner/categories.ts";
import { MANAGED_PROP } from "../planner/push.ts";
import type { CalendarProvider } from "../providers/types.ts";
import { cacheEvent } from "../sync/pull.ts";
import { MEETING_CATEGORIES, type MeetingCategory, winningPolicies } from "./model.ts";

/** Reminders look this far ahead. */
const HORIZON = 14 * DAY;

/** Built-in agenda templates per meeting type (rule 19); an admin's template replaces one. */
export const BUILTIN_TEMPLATES: Record<MeetingCategory, string> = {
  one_on_one: "1. Wins and updates\n2. Blockers\n3. Feedback\n4. Next steps",
  team_meeting: "1. Goal of this meeting\n2. Updates\n3. Decisions needed\n4. Action items",
  external_meeting: "1. Introductions and goal\n2. Discussion points\n3. Questions\n4. Next steps",
};

export function agendaTemplates(db: Db, teamId: string): Record<MeetingCategory, string> {
  const custom = new Map(
    all<{ category: MeetingCategory; body: string }>(
      db,
      "SELECT category, body FROM agenda_templates WHERE team_id = ?",
      teamId,
    ).map((t) => [t.category, t.body]),
  );
  return Object.fromEntries(
    MEETING_CATEGORIES.map((c) => [c, custom.get(c) ?? BUILTIN_TEMPLATES[c]]),
  ) as Record<MeetingCategory, string>;
}

const FOOTER = "Planned by Tempoloom.";
/** Lines of conferencing details: links, dial-in numbers and codes, separators. */
const CONFERENCING =
  /https?:\/\/|\b(meet\.google|zoom\.us|teams\.microsoft|webex)\b|^\s*(join|dial|meeting id|passcode|password|pin|phone)\b|^[\s\-_=~:─]+$/i;

/** Rule 14: at least one line of text other than conferencing details. */
export function hasAgenda(description: string): boolean {
  return description
    .replace(/<[^>]+>/g, "\n")
    .split(/\r?\n/)
    .some((l) => l.trim() !== "" && l.trim() !== FOOTER && !CONFERENCING.test(l));
}

/** "adjust": half the length, on 5 minutes, for meetings of 30 minutes or more. */
export function shorterEnd(start: number, end: number): number | null {
  const length = end - start;
  if (length < 30 * MINUTE) return null;
  return start + Math.max(15 * MINUTE, Math.floor(length / 2 / (5 * MINUTE)) * 5 * MINUTE);
}

interface EventRow extends CachedEvent {
  organizer_self: number;
  self_response: string | null;
  etag: string | null;
  private_props: string;
  all_day: number;
  account_id: string;
  provider_id: string;
}

interface ActionRow {
  id: string;
  calendar_id: string;
  event_id: string;
  kind: "reminder" | "declined";
  state: string;
  proposed_end_ms: number | null;
  proposal: string | null;
}

/** One pass over the member's upcoming meetings; runs inside the member's sync run. */
export async function enforceAgendas(
  db: Db,
  userId: string,
  provider: (accountId: string) => CalendarProvider,
  now: number,
  log: (msg: string, err?: unknown) => void,
): Promise<void> {
  const policy = winningPolicies(db, userId).get("meeting_agendas");
  if (policy?.type !== "meeting_agendas") {
    run(
      db,
      "DELETE FROM agenda_actions WHERE user_id = ? AND kind = 'reminder' AND state = 'open'",
      userId,
    );
    return;
  }
  const goal = policy.goal;
  const ctx = categoryContext(db, userId);
  const events = all<EventRow>(
    db,
    `SELECT e.*, c.account_id, c.provider_id FROM events e
       JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND (c.check_availability = 1 OR c.is_primary = 1)
       AND e.start_ms > ? AND e.start_ms < ? AND e.all_day = 0 AND e.recurring_id IS NULL
     ORDER BY e.start_ms`,
    userId,
    now,
    now + HORIZON,
  );
  const actions = new Map(
    all<ActionRow>(db, "SELECT * FROM agenda_actions WHERE user_id = ?", userId).map((a) => [
      `${a.kind}:${a.calendar_id}:${a.event_id}`,
      a,
    ]),
  );
  const seen = new Set<string>();
  for (const e of events) {
    const props = JSON.parse(e.private_props) as Record<string, string>;
    // Tempoloom's own flexible meetings keep their notes in Tempoloom, not here.
    if (props[MANAGED_PROP] === "1") continue;
    const category = externalCategory(ctx, e) as MeetingCategory;
    if (!goal.meetingTypes.includes(category)) continue;
    const agenda = hasAgenda(e.description);
    if (e.organizer_self === 1) {
      const key = `reminder:${e.calendar_id}:${e.event_id}`;
      seen.add(key);
      const cur = actions.get(key);
      if (agenda) {
        if (cur?.state === "open") {
          run(
            db,
            "UPDATE agenda_actions SET state = 'resolved', updated_at = ? WHERE id = ?",
            now,
            cur.id,
          );
        }
        continue;
      }
      const proposedEnd = goal.strictness === "adjust" ? shorterEnd(e.start_ms, e.end_ms) : null;
      if (!cur) {
        run(
          db,
          `INSERT INTO agenda_actions (id, user_id, calendar_id, event_id, policy_id, kind, state, title, category,
             start_ms, end_ms, proposed_end_ms, proposal, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'reminder', 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(),
          userId,
          e.calendar_id,
          e.event_id,
          policy.id,
          e.summary,
          category,
          e.start_ms,
          e.end_ms,
          proposedEnd,
          proposedEnd === null ? null : "pending",
          now,
          now,
        );
        continue;
      }
      // A pending proposal follows the strictness; an answered one stays as it is.
      const answered = cur.proposal === "applied" || cur.proposal === "kept";
      run(
        db,
        `UPDATE agenda_actions SET title = ?, category = ?, start_ms = ?, end_ms = ?, policy_id = ?,
           proposed_end_ms = ?, proposal = ? WHERE id = ?`,
        e.summary,
        category,
        e.start_ms,
        e.end_ms,
        policy.id,
        answered ? cur.proposed_end_ms : proposedEnd,
        answered ? cur.proposal : proposedEnd === null ? null : "pending",
        cur.id,
      );
      continue;
    }
    // Rule 17: invited members decline at the lead time; never twice (the member may accept again).
    if (
      goal.strictness !== "auto_decline" ||
      agenda ||
      // null: the member is not on the guest list (an alias, a forwarded copy).
      e.self_response === null ||
      e.self_response === "declined" ||
      e.start_ms - now > goal.leadMinutes * MINUTE ||
      actions.has(`declined:${e.calendar_id}:${e.event_id}`)
    ) {
      continue;
    }
    try {
      const ev = await provider(e.account_id).editExternal(
        e.provider_id,
        e.event_id,
        { selfResponse: "declined" },
        e.etag,
      );
      cacheEvent(db, e.calendar_id, ev);
      run(
        db,
        `INSERT INTO agenda_actions (id, user_id, calendar_id, event_id, policy_id, kind, state, title, category,
           start_ms, end_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'declined', 'done', ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        userId,
        e.calendar_id,
        e.event_id,
        policy.id,
        e.summary,
        category,
        e.start_ms,
        e.end_ms,
        now,
        now,
      );
    } catch (err) {
      log(`agenda policy could not decline ${e.event_id}`, err);
    }
  }
  // Open reminders of meetings that are gone, past, or no longer in scope.
  for (const a of actions.values()) {
    if (
      a.kind === "reminder" &&
      a.state === "open" &&
      !seen.has(`reminder:${a.calendar_id}:${a.event_id}`)
    ) {
      run(db, "DELETE FROM agenda_actions WHERE id = ?", a.id);
    }
  }
}

export interface ReminderView {
  id: string;
  title: string;
  category: MeetingCategory;
  start: number;
  end: number;
  draft: string;
  proposedEnd: number | null;
  proposal: "pending" | "applied" | "kept" | null;
}

/** Open reminders of a member, each with the draft from its type's template. */
export function remindersOf(db: Db, userId: string, teamId: string, now: number): ReminderView[] {
  const templates = agendaTemplates(db, teamId);
  return all<{
    id: string;
    title: string;
    category: MeetingCategory;
    start_ms: number;
    end_ms: number;
    proposed_end_ms: number | null;
    proposal: ReminderView["proposal"];
  }>(
    db,
    `SELECT * FROM agenda_actions WHERE user_id = ? AND kind = 'reminder' AND state = 'open' AND end_ms > ?
     ORDER BY start_ms`,
    userId,
    now,
  ).map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    start: r.start_ms,
    end: r.end_ms,
    draft: templates[r.category] ?? "",
    proposedEnd: r.proposed_end_ms,
    proposal: r.proposal,
  }));
}

export const declinedOf = (db: Db, userId: string, now: number) =>
  all<{ id: string; title: string; start_ms: number; end_ms: number }>(
    db,
    `SELECT id, title, start_ms, end_ms FROM agenda_actions
     WHERE user_id = ? AND kind = 'declined' AND end_ms > ? ORDER BY start_ms`,
    userId,
    now - DAY,
  ).map((r) => ({ id: r.id, title: r.title, start: r.start_ms, end: r.end_ms }));

/** The event behind a reminder, with what a calendar write needs. */
export function reminderEvent(db: Db, userId: string, id: string) {
  return one<{
    id: string;
    calendar_id: string;
    event_id: string;
    proposed_end_ms: number | null;
    proposal: string | null;
    description: string;
    etag: string | null;
    account_id: string;
    provider_id: string;
  }>(
    db,
    `SELECT r.id, r.calendar_id, r.event_id, r.proposed_end_ms, r.proposal, e.description, e.etag,
       c.account_id, c.provider_id
     FROM agenda_actions r JOIN events e ON e.calendar_id = r.calendar_id AND e.event_id = r.event_id
       JOIN calendars c ON c.id = r.calendar_id
     WHERE r.id = ? AND r.user_id = ? AND r.kind = 'reminder'`,
    id,
    userId,
  );
}
