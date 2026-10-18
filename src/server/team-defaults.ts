// Team defaults for new members (docs/specs/teams-settings-templates.md rules
// 3-11): habit templates, default hours and the team focus time template.
// Hours and the focus recommendation are copied when a person joins; later
// changes of a default never reach members who joined before (rule 10).
import { z } from "zod";
import { all, type Db, one, run } from "./db.ts";

const range = z
  .tuple([z.number().int().min(0).max(1439), z.number().int().min(1).max(1440)])
  .refine(([s, e]) => e > s, "A range must end after it starts");
export const weeklySchema = z.partialRecord(
  z.enum(["1", "2", "3", "4", "5", "6", "7"]),
  z.array(range).max(12),
);

/**
 * Tempoloom has the proactive focus mode only, so a template recommends a
 * proactive goal (focus-time.md open question 1). Default goal: 10 hours.
 */
export const focusTemplateSchema = z.object({
  mode: z.literal("proactive").default("proactive"),
  weeklyGoalHours: z.number().min(0.5).max(40).multipleOf(0.5).default(10),
});

const defaultsSchema = z.object({
  workHours: weeklySchema.nullable().catch(null).default(null),
  meetingHours: weeklySchema.nullable().catch(null).default(null),
  focus: focusTemplateSchema.nullable().catch(null).default(null),
});

export type TeamDefaults = z.infer<typeof defaultsSchema>;
export type FocusTemplate = z.infer<typeof focusTemplateSchema>;

/** The team's settings JSON; each stream keeps its own key. */
function teamSettings(db: Db, teamId: string): Record<string, unknown> {
  const raw = one<{ settings: string }>(db, "SELECT settings FROM teams WHERE id = ?", teamId);
  try {
    const v: unknown = JSON.parse(raw?.settings ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Reads one key of the team settings. */
export const teamSetting = (db: Db, teamId: string, key: string): unknown =>
  teamSettings(db, teamId)[key];

/** Replaces one key of the team settings and keeps the others. */
export function setTeamSetting(db: Db, teamId: string, key: string, value: unknown): void {
  run(
    db,
    "UPDATE teams SET settings = ? WHERE id = ?",
    JSON.stringify({ ...teamSettings(db, teamId), [key]: value }),
    teamId,
  );
}

export const teamDefaults = (db: Db, teamId: string): TeamDefaults =>
  defaultsSchema.parse(teamSetting(db, teamId, "defaults") ?? {});

/**
 * Gives a person who just joined the team its current defaults: the default
 * hours replace the member's work and meeting hours (rule 7; without a default
 * the member keeps their own, edge case 3), and the habit templates and the
 * focus template wait in onboarding (rules 4, 9).
 */
export function applyTeamDefaults(db: Db, teamId: string, userId: string, now: number): void {
  const d = teamDefaults(db, teamId);
  for (const [kind, weekly] of [
    ["work", d.workHours],
    ["meeting", d.meetingHours],
  ] as const) {
    if (!weekly) continue;
    for (const set of all<{ id: string }>(
      db,
      "SELECT id FROM hours_sets WHERE user_id = ? AND kind = ?",
      userId,
      kind,
    )) {
      run(db, "UPDATE hours_sets SET weekly = ? WHERE id = ?", JSON.stringify(weekly), set.id);
      // HRS-7: items that use the set are placed again.
      for (const table of ["tasks", "habits", "focus_goals"]) {
        run(db, `UPDATE ${table} SET rules_changed_at = ? WHERE hours_set_id = ?`, now, set.id);
      }
    }
  }
  const templates = Boolean(
    one(db, "SELECT 1 FROM team_habit_templates WHERE team_id = ?", teamId),
  );
  run(
    db,
    `INSERT INTO team_onboarding (user_id, team_id, focus, focus_state, welcome_done, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET team_id = excluded.team_id, focus = excluded.focus,
       focus_state = excluded.focus_state, welcome_done = excluded.welcome_done,
       joined_at = excluded.joined_at`,
    userId,
    teamId,
    d.focus ? JSON.stringify(d.focus) : null,
    d.focus ? "pending" : "none",
    templates || d.focus ? 0 : 1,
    now,
  );
}
