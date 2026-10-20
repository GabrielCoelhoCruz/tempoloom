// The priorities page and the planner priorities view
// (docs/specs/planning-priorities.md PRI-51 to PRI-53): every item with a
// priority, and one action that moves an item to another level.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { jsonBody } from "../http.ts";
import { meetingPeers } from "../planner/meetings.ts";
import type { SyncService } from "../sync/service.ts";
import { listAutomations } from "./automations.ts";
import { badRequest, nextRank } from "./items.ts";

/** The item kinds, in the order the board shows them inside one level (PRI-3). */
export const PRIORITY_KINDS = [
  "flexible_meeting",
  "buffer",
  "habit",
  "task",
  "booking_link",
  "focus_time",
] as const;
export type PriorityKind = (typeof PRIORITY_KINDS)[number];

export interface PriorityItem {
  kind: PriorityKind;
  id: string;
  title: string;
  level: number;
  /** The hours set, for the hours filter (PRI-52); null for buffers. */
  hoursSetId: string | null;
  /** Focus time stays at P4 (PRI-20). */
  fixed: boolean;
  /** Tasks only: in the next-up queue. */
  nextUp: boolean;
}

/** The tables of the kinds whose level this board changes. */
const TABLES = {
  flexible_meeting: "meetings",
  buffer: "buffers",
  habit: "habits",
  task: "tasks",
  booking_link: "booking_links",
} as const;

function hoursOf(db: Db, userId: string, table: string): Map<string, string | null> {
  return new Map(
    all<{ id: string; hours_set_id: string | null }>(
      db,
      `SELECT id, hours_set_id FROM ${table} WHERE user_id = ?`,
      userId,
    ).map((r) => [r.id, r.hours_set_id]),
  );
}

/** Every item with a priority, by level, then kind, then the order inside the kind. */
export function priorityItems(db: Db, userId: string): PriorityItem[] {
  const autos = listAutomations(db, userId).flatMap((a): PriorityItem[] => {
    const kind = a.type as PriorityKind;
    if (!PRIORITY_KINDS.includes(kind) || a.level === null) return [];
    return [
      {
        kind,
        id: a.id,
        title: a.name,
        level: a.level,
        hoursSetId: null,
        fixed: kind === "focus_time",
        nextUp: false,
      },
    ];
  });
  const hours = new Map([
    ...hoursOf(db, userId, "meetings"),
    ...hoursOf(db, userId, "habits"),
    ...hoursOf(db, userId, "focus_goals"),
  ]);
  for (const a of autos) a.hoursSetId = hours.get(a.id) ?? null;
  const tasks = all<{
    id: string;
    title: string;
    level: number;
    hours_set_id: string;
    next_up_rank: number | null;
  }>(
    db,
    `SELECT id, title, level, hours_set_id, next_up_rank FROM tasks WHERE user_id = ? AND status = 'open'
     ORDER BY next_up_rank IS NULL, next_up_rank, COALESCE(due_at, 9e15), created_at, id`,
    userId,
  ).map(
    (t): PriorityItem => ({
      kind: "task",
      id: t.id,
      title: t.title,
      level: t.level,
      hoursSetId: t.hours_set_id,
      fixed: false,
      nextUp: t.next_up_rank !== null,
    }),
  );
  const links = all<{ id: string; title: string; level: number; hours_set_id: string | null }>(
    db,
    `SELECT id, title, level, hours_set_id FROM booking_links WHERE user_id = ? AND source_id IS NULL
     ORDER BY created_at, id`,
    userId,
  ).map(
    (l): PriorityItem => ({
      kind: "booking_link",
      id: l.id,
      title: l.title,
      level: l.level,
      hoursSetId: l.hours_set_id,
      fixed: false,
      nextUp: false,
    }),
  );
  // A stable sort keeps the order inside each kind.
  return [...autos, ...tasks, ...links].sort(
    (a, b) => a.level - b.level || PRIORITY_KINDS.indexOf(a.kind) - PRIORITY_KINDS.indexOf(b.kind),
  );
}

const levelInput = z.object({
  kind: z.enum(PRIORITY_KINDS),
  id: z.string().min(1),
  level: z.number().int().min(1).max(4),
});

export function priorityRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/priorities", (c) => c.json({ items: priorityItems(db, c.get("user").id) }));

  /**
   * PRI-51, PRI-53: moves one item to another level. An automation goes last in
   * its new level (PRI-2). The scheduler places the items again in the new
   * order; for a task, every open task, so a lowered task gives its time back.
   */
  r.post("/priorities", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, levelInput);
    if (body.kind === "focus_time") badRequest("kind", "Focus time stays at P4");
    const kind = body.kind as keyof typeof TABLES;
    const table = TABLES[kind];
    const cur = one<{ level: number }>(
      db,
      `SELECT level FROM ${table} WHERE id = ? AND user_id = ?${table === "booking_links" ? " AND source_id IS NULL" : ""}`,
      body.id,
      user.id,
    );
    if (!cur) badRequest("id", "Unknown item");
    const t = now();
    if (cur.level !== body.level) {
      tx(db, () => {
        if (kind === "task") {
          run(db, "UPDATE tasks SET level = ? WHERE id = ?", body.level, body.id);
          run(
            db,
            "UPDATE tasks SET rules_changed_at = ? WHERE user_id = ? AND status = 'open'",
            t,
            user.id,
          );
        } else if (kind === "booking_link") {
          run(db, "UPDATE booking_links SET level = ? WHERE id = ?", body.level, body.id);
        } else {
          run(
            db,
            `UPDATE ${table} SET level = ?, rank = ?, rules_changed_at = ? WHERE id = ?`,
            body.level,
            nextRank(db, table as "habits" | "buffers" | "meetings", user.id, body.level),
            t,
            body.id,
          );
        }
      });
    }
    sync.request(user.id);
    if (kind === "flexible_meeting")
      for (const id of meetingPeers(db, user.id).attendees) sync.request(id);
    return c.json({ items: priorityItems(db, user.id) });
  });

  return r;
}
