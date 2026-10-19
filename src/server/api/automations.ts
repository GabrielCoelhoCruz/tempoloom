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
import type { SyncService } from "../sync/service.ts";
import { badRequest } from "./items.ts";
import { adminTeam } from "./meeting-checks.ts";

/**
 * One automation type with a table. A new type adds one entry here and one in
 * src/web/views/automations.tsx. Meeting checks have no table; see meetingCheckEntries.
 */
export interface ListedType {
  type: string;
  table: string;
  /** The scheduler's order inside one priority and rank (planning-scheduler.md). */
  order: number;
  /** A fixed priority, such as P4 for focus time (rule 8); null: no priority, its own section (rule 9). */
  fixedLevel?: number | null;
  /** The table has the `event_settings` and `template_id` columns. */
  settings: boolean;
}

export const LISTED_TYPES: ListedType[] = [
  { type: "flexible_meeting", table: "meetings", order: 0, settings: false },
  { type: "buffer", table: "buffers", order: 1, settings: true },
  { type: "habit", table: "habits", order: 2, settings: true },
  // Rule 15: both focus automations are placed after every other request, in
  // their P4 order; at one rank the meeting overload goes first.
  {
    type: "meeting_overload",
    table: "meeting_overloads",
    order: 3,
    fixedLevel: 4,
    settings: false,
  },
  { type: "focus_time", table: "focus_goals", order: 4, fixedLevel: 4, settings: true },
];

export interface ListedAutomation {
  type: string;
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

/** Rule 9: the meeting checks, without priority: each built-in check, then the team's company checks. */
function meetingCheckEntries(db: Db, userId: string): ListedAutomation[] {
  const on = getPrefs(db, userId).checks;
  const locked = adminTeam(db, userId) === null;
  const entry = (id: string, name: string, enabled: boolean, rank: number) => ({
    type: "meeting_check",
    id,
    name,
    emoji: "",
    enabled,
    level: null,
    rank,
    templateId: null,
    createdAt: 0,
  });
  return [
    ...CHECK_IDS.map((id, i) => ({
      ...entry(id, CHECK_NAMES[id], on[id], i),
      check: { kind: "built_in" as const, locked: false },
    })),
    ...companyChecks(db, userId).map((c, i) => ({
      ...entry(`company:${c.id}`, c.name, c.enabled, CHECK_IDS.length + i),
      check: { kind: "company" as const, locked },
    })),
  ];
}

const levelOf = (t: ListedType) =>
  t.fixedLevel === undefined ? "level" : t.fixedLevel === null ? "NULL" : String(t.fixedLevel);

/** All automations in list order: priority, rank, then the scheduler's type order and age; meeting checks last. */
export function listAutomations(db: Db, userId: string): ListedAutomation[] {
  const out: (ListedAutomation & { order: number })[] = [];
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
         ${t.settings ? "event_settings, template_id" : "NULL AS event_settings, NULL AS template_id"}
       FROM ${t.table} WHERE user_id = ?`,
      userId,
    );
    for (const r of rows) {
      const es = JSON.parse(r.event_settings ?? "{}") as { emoji?: string };
      out.push({
        type: t.type,
        id: r.id,
        name: r.title,
        emoji: es.emoji ?? "",
        enabled: r.enabled === 1,
        level: r.level,
        rank: r.rank,
        templateId: r.template_id,
        createdAt: r.created_at,
        order: t.order,
      });
    }
  }
  const ranked = out
    .sort(
      (a, b) =>
        (a.level ?? 9) - (b.level ?? 9) ||
        a.rank - b.rank ||
        a.order - b.order ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    )
    .map(({ order: _, ...a }) => a);
  return [...ranked, ...meetingCheckEntries(db, userId)];
}

const orderInput = z.object({
  level: z.number().int().min(1).max(4),
  /** The whole group after the change, top first. */
  items: z
    .array(z.object({ type: z.string(), id: z.string() }))
    .min(1)
    .max(500),
});

export function automationRoutes(db: Db, sync: SyncService): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/automations", (c) => c.json({ automations: listAutomations(db, c.get("user").id) }));

  /**
   * Rules 7 and 8: sets the order of one priority group. An automation from
   * another group moves to this one and takes its priority.
   */
  r.post("/automations/order", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, orderInput);
    const items = body.items.map((it) => {
      const t = LISTED_TYPES.find((x) => x.type === it.type);
      if (!t) badRequest("items", `Unknown automation type ${it.type}`);
      if (t.fixedLevel === null) badRequest("items", "This automation has no priority");
      if (t.fixedLevel !== undefined && t.fixedLevel !== body.level) {
        badRequest("level", `This automation stays at P${t.fixedLevel}`);
      }
      if (!one(db, `SELECT 1 FROM ${t.table} WHERE id = ? AND user_id = ?`, it.id, user.id)) {
        badRequest("items", "Unknown automation");
      }
      return { t, id: it.id };
    });
    let meetings = false;
    tx(db, () => {
      items.forEach(({ t, id }, rank) => {
        if (t.fixedLevel !== undefined) {
          run(db, `UPDATE ${t.table} SET rank = ? WHERE id = ?`, rank, id);
          return;
        }
        run(db, `UPDATE ${t.table} SET level = ?, rank = ? WHERE id = ?`, body.level, rank, id);
        if (t.table === "meetings") meetings = true;
      });
    });
    // Rule 18: a new order is a saved change; the attendees' plans hold the meeting too.
    sync.request(user.id);
    if (meetings) for (const id of meetingPeers(db, user.id).attendees) sync.request(id);
    return c.json({ automations: listAutomations(db, user.id) });
  });

  return r;
}
