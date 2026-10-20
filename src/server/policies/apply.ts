// The automations that focus time and buffer policies make for each member in
// scope (docs/specs/teams-policies.md rules 2-4, 7, 9, 12). They are ordinary
// focus goals, buffers and habits, linked to their policy in
// policy_automations. Each sync run of a member brings them in line with the
// policies that apply now, so directory changes need no admin action (rule 3).
import { randomUUID } from "node:crypto";
import { insertRank } from "../api/items.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import type { MeetingCategory, Policy } from "./model.ts";
import { winningPolicies } from "./model.ts";

export const CATEGORY_LABELS: Record<MeetingCategory, string> = {
  one_on_one: "one-on-one",
  team_meeting: "team meeting",
  external_meeting: "external meeting",
};

export type Desired =
  | { key: string; kind: "focus"; minutes: number }
  | {
      key: string;
      kind: "buffer";
      title: string;
      side: "before" | "after";
      minutes: number;
      category: MeetingCategory;
    }
  | { key: string; kind: "habit"; title: string; minutes: number };

/** The automations a policy asks for. */
export function desiredFor(p: Policy): Desired[] {
  if (p.type === "focus_time") {
    return [{ key: "focus", kind: "focus", minutes: p.goal.weeklyGoalMinutes }];
  }
  if (p.type !== "buffers") return [];
  const out: Desired[] = [];
  if (p.goal.minDailyBreakMinutes > 0) {
    out.push({ key: "break", kind: "habit", title: "Break", minutes: p.goal.minDailyBreakMinutes });
  }
  const add = (
    rules: { category: MeetingCategory; minutes: number }[],
    name: string,
    label: string,
    side: "before" | "after",
  ) => {
    for (const r of rules) {
      out.push({
        key: `${name}:${r.category}`,
        kind: "buffer",
        title: `${label}: ${CATEGORY_LABELS[r.category]}`,
        side,
        minutes: r.minutes,
        category: r.category,
      });
    }
  };
  add(p.goal.prepBefore, "prep", "Prep", "before");
  add(p.goal.followUpAfter, "follow_up", "Follow-up", "after");
  add(p.goal.recoveryAfter, "recovery", "Recovery", "after");
  return out;
}

export interface Link {
  policy_id: string;
  user_id: string;
  key: string;
  kind: "focus" | "buffer" | "habit";
  item_id: string;
  personalized: number;
}

const TABLE = { focus: "focus_goals", buffer: "buffers", habit: "habits" } as const;

const workHours = (db: Db, userId: string) =>
  one<{ id: string }>(
    db,
    "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
    userId,
  )?.id;

/** A daily maximum that lets the weekly goal fit into 5 workdays. */
const dailyMax = (weekly: number) => Math.max(240, Math.ceil(weekly / 5 / 15) * 15);

function insertItem(db: Db, userId: string, d: Desired, now: number): string | null {
  const id = randomUUID();
  const hours = workHours(db, userId);
  if (!hours) return null;
  if (d.kind === "focus") {
    run(
      db,
      `INSERT INTO focus_goals (id, user_id, title, enabled, hours_set_id, weekly_goal_minutes, daily_min_minutes,
         daily_max_minutes, min_block_minutes, max_block_minutes, busy, created_at, rules_changed_at)
       VALUES (?, ?, 'Focus time', 1, ?, ?, 0, ?, 60, 240, 1, ?, ?)`,
      id,
      userId,
      hours,
      d.minutes,
      dailyMax(d.minutes),
      now,
      now,
    );
  } else if (d.kind === "buffer") {
    run(
      db,
      `INSERT INTO buffers (id, user_id, title, enabled, level, rank, side, minutes_before, minutes_after, busy, filter,
         on_conflict, created_at, rules_changed_at) VALUES (?, ?, ?, 1, 3, ?, ?, ?, ?, 1, ?, 'remove', ?, ?)`,
      id,
      userId,
      d.title,
      insertRank(db, "buffers", userId, 3),
      d.side,
      d.side === "before" ? d.minutes : 0,
      d.side === "after" ? d.minutes : 0,
      JSON.stringify({ categories: [d.category] }),
      now,
      now,
    );
  } else {
    run(
      db,
      `INSERT INTO habits (id, user_id, title, notes, enabled, level, rank, hours_set_id, ideal_minute, min_minutes,
         max_minutes, frequency, starting, defense, when_unplaceable, reserved_words, created_at, rules_changed_at)
       VALUES (?, ?, ?, '', 1, 3, ?, ?, 720, ?, ?, '{"period":"daily"}', NULL, 'adaptive', 'remove', '[]', ?, ?)`,
      id,
      userId,
      d.title,
      insertRank(db, "habits", userId, 3),
      hours,
      d.minutes,
      d.minutes,
      now,
      now,
    );
  }
  return id;
}

/** Writes the policy's values when they differ, so an unchanged item keeps its placements. */
function updateItem(db: Db, userId: string, id: string, d: Desired, now: number): void {
  if (d.kind === "focus") {
    run(
      db,
      `UPDATE focus_goals SET weekly_goal_minutes = ?, daily_max_minutes = ?, rules_changed_at = ?
       WHERE id = ? AND user_id = ? AND weekly_goal_minutes <> ?`,
      d.minutes,
      dailyMax(d.minutes),
      now,
      id,
      userId,
      d.minutes,
    );
  } else if (d.kind === "buffer") {
    const before = d.side === "before" ? d.minutes : 0;
    const after = d.side === "after" ? d.minutes : 0;
    run(
      db,
      `UPDATE buffers SET minutes_before = ?, minutes_after = ?, rules_changed_at = ?
       WHERE id = ? AND user_id = ? AND (minutes_before <> ? OR minutes_after <> ?)`,
      before,
      after,
      now,
      id,
      userId,
      before,
      after,
    );
  } else {
    run(
      db,
      `UPDATE habits SET min_minutes = ?, max_minutes = ?, rules_changed_at = ?
       WHERE id = ? AND user_id = ? AND (min_minutes <> ? OR max_minutes <> ?)`,
      d.minutes,
      d.minutes,
      now,
      id,
      userId,
      d.minutes,
      d.minutes,
    );
  }
}

function removeItem(db: Db, l: Link): void {
  run(db, `DELETE FROM ${TABLE[l.kind]} WHERE id = ? AND user_id = ?`, l.item_id, l.user_id);
  if (l.kind === "habit") {
    run(
      db,
      "DELETE FROM item_exclusions WHERE user_id = ? AND kind = 'habit' AND item_id = ?",
      l.user_id,
      l.item_id,
    );
  }
  run(
    db,
    "DELETE FROM policy_automations WHERE policy_id = ? AND user_id = ? AND key = ?",
    l.policy_id,
    l.user_id,
    l.key,
  );
}

/** Deletes every automation a policy made, for all members (the policy is going away). */
export function removeAutomations(db: Db, policyId: string): void {
  for (const l of all<Link>(db, "SELECT * FROM policy_automations WHERE policy_id = ?", policyId)) {
    removeItem(db, l);
  }
}

/**
 * Brings the member's policy automations in line with the policies that apply
 * now: creates missing ones, applies a new goal unless the member personalized
 * the automation (open question 8), and removes those of policies that no
 * longer apply.
 */
export function applyPolicies(db: Db, userId: string, now: number): void {
  const links = all<Link>(db, "SELECT * FROM policy_automations WHERE user_id = ?", userId);
  const winners = winningPolicies(db, userId);
  if (links.length === 0 && winners.size === 0) return;
  const desired = new Map<string, { policyId: string; d: Desired }>();
  for (const p of winners.values()) {
    for (const d of desiredFor(p)) desired.set(`${p.id}|${d.key}`, { policyId: p.id, d });
  }
  tx(db, () => {
    for (const l of links) if (!desired.has(`${l.policy_id}|${l.key}`)) removeItem(db, l);
    for (const [k, { policyId, d }] of desired) {
      const link = links.find((l) => `${l.policy_id}|${l.key}` === k);
      const exists =
        link &&
        one(
          db,
          `SELECT 1 FROM ${TABLE[link.kind]} WHERE id = ? AND user_id = ?`,
          link.item_id,
          userId,
        );
      if (link && exists) {
        if (!link.personalized) updateItem(db, userId, link.item_id, d, now);
        continue;
      }
      const id = insertItem(db, userId, d, now);
      if (!id) continue;
      run(
        db,
        `INSERT INTO policy_automations (policy_id, user_id, key, kind, item_id, personalized)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT (policy_id, user_id, key) DO UPDATE SET item_id = excluded.item_id, personalized = 0`,
        policyId,
        userId,
        d.key,
        d.kind,
        id,
      );
    }
  });
}
