// The automation list (docs/specs/automations-overview.md rules 6-14): every
// automation of the user in one list, grouped by priority and ranked inside
// each group. Each type keeps its own table, form and endpoints; this module
// lists them and changes their priority and rank.
import { Hono } from "hono";
import { z } from "zod";
import { CHECK_NAMES } from "../../shared/meeting-checks.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { jsonBody } from "../http.ts";
import { companyChecks } from "../meeting-checks.ts";
import { CHECK_IDS, getPrefs } from "../meeting-prefs.ts";
import { meetingPeers } from "../planner/meetings.ts";
import { waitingCalendars } from "../planner/write.ts";
import type { SyncService } from "../sync/service.ts";
import { badRequest } from "./items.ts";
import { adminTeam } from "./meeting-checks.ts";

/**
 * Every automation type, in the scheduler's order inside one priority and rank
 * (planning-scheduler.md); meeting checks, without a table, last.
 */
export const AUTOMATION_TYPES = [
  "flexible_meeting",
  "buffer",
  "habit",
  "meeting_overload",
  "focus_time",
  "meeting_check",
] as const;
export type AutomationType = (typeof AUTOMATION_TYPES)[number];

/**
 * One automation type with a table. A new type adds one entry here and one in
 * src/web/views/automations.tsx. Meeting checks have no table; see meetingCheckEntries.
 */
export interface ListedType {
  type: Exclude<AutomationType, "meeting_check">;
  table: string;
  /** A fixed priority, such as P4 for focus time (rule 8); null: no priority, its own section (rule 9). */
  fixedLevel?: number | null;
  /** The table has the `event_settings` and `template_id` columns. */
  settings: boolean;
}

export const LISTED_TYPES: ListedType[] = [
  { type: "flexible_meeting", table: "meetings", settings: false },
  { type: "buffer", table: "buffers", settings: true },
  { type: "habit", table: "habits", settings: true },
  // Rule 15: both focus automations are placed after every other request, in
  // their P4 order; at one rank the meeting overload goes first.
  {
    type: "meeting_overload",
    table: "meeting_overloads",
    fixedLevel: 4,
    settings: false,
  },
  { type: "focus_time", table: "focus_goals", fixedLevel: 4, settings: true },
];

/** The automation types whose events go to a calendar chosen in their event settings. */
const PLANNED = new Set<AutomationType>(["flexible_meeting", "buffer", "habit", "focus_time"]);

export interface ListedAutomation {
  /** The email of the disconnected account that holds the automation's calendar (accounts rule 16). */
  disconnected?: string;
  type: AutomationType;
  id: string;
  name: string;
  emoji: string;
  enabled: boolean;
  /** P1 to P4; null for a type without priority. */
  level: number | null;
  rank: number;
  templateId: string | null;
  createdAt: number;
  /**
   * Meeting checks only: a built-in check, which every user keeps, or a
   * company check, which only team admins change (automations-meeting-quality.md rules 2, 11).
   */
  check?: { kind: "built_in" | "company"; locked: boolean };
}

/**
 * Rule 9: the meeting checks, without priority: each built-in check, then the
 * team's company checks, oldest first. Each key holds only stored values, so a
 * company check added or deleted between two pages moves no other check.
 */
function meetingCheckEntries(db: Db, userId: string): ListedAutomation[] {
  const on = getPrefs(db, userId).checks;
  const locked = adminTeam(db, userId) === null;
  const created = new Map(
    all<{ id: string; created_at: number }>(
      db,
      `SELECT c.id, c.created_at FROM company_checks c
         JOIN team_members m ON m.team_id = c.team_id WHERE m.user_id = ?`,
      userId,
    ).map((c) => [c.id, c.created_at]),
  );
  const entry = (id: string, name: string, enabled: boolean, rank: number, createdAt: number) => ({
    type: "meeting_check" as const,
    id,
    name,
    emoji: "",
    enabled,
    level: null,
    rank,
    templateId: null,
    createdAt,
  });
  return [
    ...CHECK_IDS.map((id, i) => ({
      ...entry(id, CHECK_NAMES[id], on[id], i, 0),
      check: { kind: "built_in" as const, locked: false },
    })),
    // One rank for every company check, after the built-in ones: age and id order them.
    ...companyChecks(db, userId).map((c) => ({
      ...entry(`company:${c.id}`, c.name, c.enabled, CHECK_IDS.length, created.get(c.id) ?? 0),
      check: { kind: "company" as const, locked },
    })),
  ];
}

const levelOf = (t: ListedType) =>
  t.fixedLevel === undefined ? "level" : t.fixedLevel === null ? "NULL" : String(t.fixedLevel);

/** The sort key of the automation list, unique per automation. */
type ListKey = [level: number, rank: number, type: AutomationType, createdAt: number, id: string];

/** Rules 6-9: priority (none last), rank, the scheduler's type order, age, then id. */
const listKey = (a: ListedAutomation): ListKey => [a.level ?? 9, a.rank, a.type, a.createdAt, a.id];

function compareListKeys(a: ListKey, b: ListKey): number {
  for (let i = 0; i < a.length; i++) {
    const x = i === 2 ? AUTOMATION_TYPES.indexOf(a[2]) : (a[i] as string | number);
    const y = i === 2 ? AUTOMATION_TYPES.indexOf(b[2]) : (b[i] as string | number);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** A list key in a page cursor: the type by name, so a new type does not shift the old keys. */
export const listKeySchema = z.tuple([
  z.number(),
  z.number(),
  z.enum(AUTOMATION_TYPES),
  z.number(),
  z.string(),
]);

/**
 * One page of the automation list: the automations after the key `after`, at
 * most `limit`, and the key of the last one when more follow.
 */
export function listAutomationsPage(
  db: Db,
  userId: string,
  after: ListKey | undefined,
  limit: number,
): { rows: ListedAutomation[]; next?: ListKey } {
  const rest = listAutomations(db, userId).filter(
    (a) => !after || compareListKeys(listKey(a), after) > 0,
  );
  const rows = rest.slice(0, limit);
  const last = rows.at(-1);
  return rest.length > limit && last ? { rows, next: listKey(last) } : { rows };
}

/** All automations in list order (listKey); meeting checks, without priority, last. */
export function listAutomations(db: Db, userId: string): ListedAutomation[] {
  const out: ListedAutomation[] = [];
  const waiting = waitingCalendars(db, userId);
  for (const t of LISTED_TYPES) {
    const rows = all<{
      id: string;
      title: string;
      enabled: number;
      level: number | null;
      rank: number;
      created_at: number;
      event_settings: string | null;
      template_id: string | null;
    }>(
      db,
      `SELECT id, title, enabled, ${levelOf(t)} AS level, rank, created_at,
         ${
           t.settings
             ? "event_settings, template_id"
             : t.type === "flexible_meeting"
               ? "event_settings, NULL AS template_id"
               : "NULL AS event_settings, NULL AS template_id"
         }
       FROM ${t.table} WHERE user_id = ?`,
      userId,
    );
    for (const r of rows) {
      const es = JSON.parse(r.event_settings ?? "{}") as { emoji?: string; calendarId?: string };
      // Accounts rule 16: the calendar of a planned automation is on a disconnected account.
      const disconnected = PLANNED.has(t.type) ? waiting(es.calendarId) : null;
      out.push({
        ...(disconnected ? { disconnected } : {}),
        type: t.type,
        id: r.id,
        name: r.title,
        emoji: es.emoji ?? "",
        enabled: r.enabled === 1,
        level: r.level,
        rank: r.rank,
        templateId: r.template_id,
        createdAt: r.created_at,
      });
    }
  }
  return [...out, ...meetingCheckEntries(db, userId)].sort((a, b) =>
    compareListKeys(listKey(a), listKey(b)),
  );
}

/** One priority group in list order: the scheduler's order (rules 7, 8, 14); focus time is in P4. */
const levelGroup = (db: Db, userId: string, level: number) =>
  listAutomations(db, userId).filter((a) => a.level === level && a.type !== "meeting_check");

/**
 * SCH-71: the rank of a new flexible meeting, buffer or habit. Ranks are one
 * list per level. It goes after the last automation of its level whose type
 * comes at or before its own in AUTOMATION_TYPES, else to the top; the
 * automations after it move down one, so a dragged order stays. The caller
 * runs this and the insert in one transaction.
 */
export function insertRank(
  db: Db,
  type: "flexible_meeting" | "buffer" | "habit",
  userId: string,
  level: number,
): number {
  const group = levelGroup(db, userId, level);
  const kind = AUTOMATION_TYPES.indexOf(type);
  const at = group.findLastIndex((a) => AUTOMATION_TYPES.indexOf(a.type) <= kind) + 1;
  group.forEach((a, i) => {
    const rank = i < at ? i : i + 1;
    const table = LISTED_TYPES.find((t) => t.type === a.type)?.table;
    if (table && a.rank !== rank) run(db, `UPDATE ${table} SET rank = ? WHERE id = ?`, rank, a.id);
  });
  return at;
}

/** Rule 7: an automation that changes priority goes to the end of its new group. */
export const endRank = (db: Db, userId: string, level: number): number =>
  Math.max(-1, ...levelGroup(db, userId, level).map((a) => a.rank)) + 1;

const orderInput = z.object({
  level: z.number().int().min(1).max(4),
  /** The whole group after the change, top first. */
  items: z
    .array(z.object({ type: z.string(), id: z.string() }))
    .min(1)
    .max(500),
});

/**
 * Rules 7 and 8: sets the order of one priority group, top first. An
 * automation from another group moves to this one and takes its priority.
 * The automation list and the priorities page (PRI-51, PRI-53) both use it.
 */
export function orderAutomations(
  db: Db,
  sync: SyncService,
  userId: string,
  level: number,
  group: { type: string; id: string }[],
  t: number,
): void {
  const items = group.map((it) => {
    const type = LISTED_TYPES.find((x) => x.type === it.type);
    if (!type) badRequest("items", `Unknown automation type ${it.type}`);
    if (type.fixedLevel === null) badRequest("items", "This automation has no priority");
    if (type.fixedLevel !== undefined && type.fixedLevel !== level) {
      badRequest("level", `This automation stays at P${type.fixedLevel}`);
    }
    if (!one(db, `SELECT 1 FROM ${type.table} WHERE id = ? AND user_id = ?`, it.id, userId)) {
      badRequest("items", "Unknown automation");
    }
    return { type, id: it.id };
  });
  let meetings = false;
  tx(db, () => {
    items.forEach(({ type, id }, rank) => {
      if (type.fixedLevel !== undefined) {
        run(db, `UPDATE ${type.table} SET rank = ? WHERE id = ?`, rank, id);
        return;
      }
      if (type.table === "meetings") {
        // A meeting whose rank or priority changed is placed again (meetings-flexible.md
        // edge case 9: the lower rank wins a slot that two meetings want).
        run(
          db,
          `UPDATE meetings SET rules_changed_at = ? WHERE id = ? AND (level <> ? OR rank <> ?)`,
          t,
          id,
          level,
          rank,
        );
        meetings = true;
      }
      run(db, `UPDATE ${type.table} SET level = ?, rank = ? WHERE id = ?`, level, rank, id);
    });
  });
  // Rule 18: a new order is a saved change; the attendees' plans hold the meeting too.
  sync.request(userId);
  if (meetings) for (const id of meetingPeers(db, userId).attendees) sync.request(id);
}

export function automationRoutes(
  db: Db,
  sync: SyncService,
  now: () => number = Date.now,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/automations", (c) => c.json({ automations: listAutomations(db, c.get("user").id) }));

  /** Rules 7 and 8: sets the order of one priority group (orderAutomations). */
  r.post("/automations/order", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, orderInput);
    orderAutomations(db, sync, user.id, body.level, body.items, now());
    return c.json({ automations: listAutomations(db, user.id) });
  });

  return r;
}
