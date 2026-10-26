// The shared tables of preview mode (docs/specs/assistant-preview-mode.md):
// the automation kinds whose form saves it knows, and the shared settings
// whose replayed change apply checks for staleness. The preview guard and the
// chat's automation and policy tools read them here.
import { type Db, one } from "./db.ts";

/**
 * The automation kinds whose saves preview mode knows: the API path (`/api/<plural>`),
 * the table, the noun in summaries and the method of an edit. `guarded`: a form
 * save stages while preview mode is on, so it replaces an open chat proposal of
 * the same automation (target `<plural>:<id>`). The other kinds save at once;
 * apply then skips an older proposal by the stale check (rules_changed_at).
 */
export const AUTOMATION_KINDS = {
  habit: { plural: "habits", table: "habits", noun: "habit", edit: "PATCH", guarded: true },
  focus_time: {
    plural: "focus",
    table: "focus_goals",
    noun: "focus goal",
    edit: "PATCH",
    guarded: true,
  },
  buffer: { plural: "buffers", table: "buffers", noun: "buffer", edit: "PATCH", guarded: true },
  meeting_overload: {
    plural: "meeting-overloads",
    table: "meeting_overloads",
    noun: "meeting overload",
    edit: "PATCH",
    guarded: false,
  },
  flexible_meeting: {
    plural: "meetings",
    table: "meetings",
    noun: "flexible meeting",
    edit: "PUT",
    guarded: false,
  },
} as const;
export type AutomationKind = keyof typeof AUTOMATION_KINDS;

/** The guarded kinds by their API plural. */
export const GUARDED: ReadonlyMap<string, (typeof AUTOMATION_KINDS)[AutomationKind]> = new Map(
  Object.values(AUTOMATION_KINDS)
    .filter((k) => k.guarded)
    .map((k) => [k.plural, k]),
);

/**
 * Shared settings a replayed request changes, with what tells that they
 * changed since staging: a team policy's updated_at, and the meeting
 * preferences' stored text (it has no time column; any change differs).
 * Undefined: the setting is gone. Meeting prefs never saved: null.
 */
const VERSIONS = {
  team_policy: (db: Db, id: string, userId: string) =>
    one<{ v: number }>(
      db,
      `SELECT updated_at AS v FROM team_policies WHERE id = ?
       AND team_id = (SELECT team_id FROM team_members WHERE user_id = ?)`,
      id,
      userId,
    )?.v,
  meeting_prefs: (db: Db, _id: string, userId: string) =>
    one<{ v: string }>(db, "SELECT prefs AS v FROM meeting_prefs WHERE user_id = ?", userId)?.v ??
    null,
} as const;

export const VERSION_NOUNS: Record<keyof typeof VERSIONS, string> = {
  team_policy: "team policy",
  meeting_prefs: "meeting check setting",
};

export interface Version {
  of: keyof typeof VERSIONS;
  id: string;
  value: number | string | null;
}

/** The version of a shared setting now. */
export function versionOf(
  db: Db,
  of: Version["of"],
  id: string,
  userId: string,
): number | string | null | undefined {
  return VERSIONS[of](db, id, userId);
}
