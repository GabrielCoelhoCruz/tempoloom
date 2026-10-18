// Flexible meetings (docs/specs/meetings-flexible.md, meetings-flexible-rescheduling.md).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { plan } from "../../scheduler/plan.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import {
  type Attendee,
  attendeesOf,
  instanceUser,
  type MeetingRow,
  meetingItem,
  meetingPeers,
} from "../planner/meetings.ts";
import { loadSnapshot } from "../planner/replan.ts";
import { getSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";
import { badRequest, hhmm, hoursSetId, nextRank } from "./items.ts";

const fiveMinutes = z.number().int().min(5).max(480).multipleOf(5);
const meetingInput = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(8000).default(""),
  location: z.string().max(500).default(""),
  attendees: z
    .array(z.object({ email: z.email(), required: z.boolean().default(true) }))
    .min(1)
    .max(50),
  frequency: z.discriminatedUnion("period", [
    z.object({ period: z.literal("daily") }),
    z.object({
      period: z.literal("weekly"),
      everyWeeks: z.number().int().min(1).max(52),
      idealDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    }),
  ]),
  idealTime: hhmm,
  durationMinutes: fiveMinutes,
  shortestMinutes: fiveMinutes.optional(),
  hoursMode: z.enum(["everyone", "organizer"]).default("everyone"),
  hoursSetId: z.string().optional(),
  starting: z.iso.date().nullable().default(null),
  level: z.number().int().min(1).max(4).default(2),
  defense: z.enum(["adaptive", "busy", "free"]).default("adaptive"),
  whenUnplaceable: z.enum(["remove", "keep_as_conflict"]).default("keep_as_conflict"),
  leadHours: z.number().int().min(0).max(168).default(12),
});
type MeetingInput = z.infer<typeof meetingInput>;

function rowFrom(
  db: Db,
  userId: string,
  id: string,
  b: MeetingInput,
  t: number,
  rank: number,
): { row: MeetingRow; attendees: Attendee[] } {
  const email = one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email;
  const attendees = b.attendees
    .map((a) => ({ email: a.email.toLowerCase(), required: a.required }))
    .filter((a, i, list) => a.email !== email && list.findIndex((x) => x.email === a.email) === i);
  if (attendees.length === 0) badRequest("attendees", "Invite at least one other person");
  const shortest = b.shortestMinutes ?? b.durationMinutes;
  if (shortest > b.durationMinutes)
    badRequest("shortestMinutes", "The shortest length must not be above the duration");
  const [h, m] = b.idealTime.split(":").map(Number) as [number, number];
  return {
    attendees,
    row: {
      id,
      user_id: userId,
      title: b.title,
      description: b.description,
      location: b.location,
      enabled: 1,
      level: b.level as MeetingRow["level"],
      rank,
      frequency: JSON.stringify(b.frequency),
      ideal_minute: h * 60 + m,
      duration_minutes: b.durationMinutes,
      shortest_minutes: shortest,
      hours_mode: b.hoursMode,
      hours_set_id: hoursSetId(db, userId, b.hoursSetId, "meeting"),
      starting: b.starting,
      defense: b.defense,
      when_unplaceable: b.whenUnplaceable,
      lead_minutes: b.leadHours * 60,
      created_at: t,
      rules_changed_at: t,
    },
  };
}

function save(db: Db, row: MeetingRow, attendees: Attendee[], insert: boolean): void {
  const cols = [
    "title",
    "description",
    "location",
    "level",
    "rank",
    "frequency",
    "ideal_minute",
    "duration_minutes",
    "shortest_minutes",
    "hours_mode",
    "hours_set_id",
    "starting",
    "defense",
    "when_unplaceable",
    "lead_minutes",
    "rules_changed_at",
  ] as const;
  const values = cols.map((k) => row[k]);
  if (insert) {
    run(
      db,
      `INSERT INTO meetings (id, user_id, created_at, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})`,
      row.id,
      row.user_id,
      row.created_at,
      ...values,
    );
  } else {
    run(
      db,
      `UPDATE meetings SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...values,
      row.id,
    );
  }
  run(db, "DELETE FROM meeting_attendees WHERE meeting_id = ?", row.id);
  for (const a of attendees) {
    run(
      db,
      "INSERT INTO meeting_attendees (meeting_id, email, required) VALUES (?, ?, ?)",
      row.id,
      a.email,
      a.required ? 1 : 0,
    );
  }
}

/** What Tempoloom can see of a person (rules 4-5). */
function person(db: Db, email: string) {
  const user = instanceUser(db, email);
  return user
    ? { email, class: "user" as const, name: user.name, timeZone: user.time_zone }
    : { email, class: "none" as const, name: null, timeZone: null };
}

export function meetingRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const changed = (userId: string) => {
    sync.request(userId);
    for (const id of meetingPeers(db, userId).attendees) sync.request(id);
  };
  const own = (id: string, userId: string) => {
    const row = one<MeetingRow>(
      db,
      "SELECT * FROM meetings WHERE id = ? AND user_id = ?",
      id,
      userId,
    );
    if (!row) notFound("meeting");
    return row;
  };

  r.get("/meetings", (c) => {
    const user = c.get("user");
    const report = JSON.parse(
      one<{ report: string }>(db, "SELECT report FROM plan_reports WHERE user_id = ?", user.id)
        ?.report ?? "[]",
    ) as { itemKind: string; itemId: string; demandKey: string; status: string; reason: string }[];
    const meetings = all<MeetingRow>(
      db,
      "SELECT * FROM meetings WHERE user_id = ? ORDER BY level, rank, created_at",
      user.id,
    ).map((m) => ({
      ...m,
      frequency: JSON.parse(m.frequency) as unknown,
      attendees: attendeesOf(db, m.id).map((a) => ({ ...a, ...person(db, a.email) })),
      occurrences: all<{ key: string; start_ms: number; end_ms: number; locked: number }>(
        db,
        `SELECT key, start_ms, end_ms, locked FROM managed_events
         WHERE user_id = ? AND kind = 'meeting' AND source_id = ? AND end_ms > ? ORDER BY start_ms`,
        user.id,
        m.id,
        now(),
      ),
      problems: report.filter((e) => e.itemKind === "meeting" && e.itemId === m.id),
    }));
    return c.json({ meetings });
  });

  r.get("/meetings/person", (c) => {
    const email = z.email().safeParse(c.req.query("email"));
    if (!email.success) return c.json({ error: "invalid_email" }, 400);
    return c.json(person(db, email.data.toLowerCase()));
  });

  /** Rule 8: the next occurrences before the rules are saved. */
  r.post("/meetings/preview", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, meetingInput);
    const t = now();
    const { row, attendees } = rowFrom(db, user.id, "preview", body, t, 0);
    const zone =
      one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", user.id)
        ?.time_zone ?? "UTC";
    const last =
      one<{ planned_at: number }>(
        db,
        "SELECT planned_at FROM plan_reports WHERE user_id = ?",
        user.id,
      )?.planned_at ?? 0;
    const { snapshot } = loadSnapshot(db, user.id, zone, getSettings(db, user.id), t, last);
    const item = meetingItem(db, user.id, row, attendees, t, snapshot.windowEnd, last, new Map());
    const result = plan({ ...snapshot, meetings: [...snapshot.meetings, item] });
    const before = new Map(snapshot.current.map((p) => [p.key, p]));
    const moved = result.placements.filter((p) => {
      const b = before.get(p.key);
      return p.itemId !== "preview" && b && (b.start !== p.start || b.end !== p.end);
    }).length;
    return c.json({
      occurrences: result.placements
        .filter((p) => p.itemId === "preview")
        .slice(0, 4)
        .map((p) => ({ start: p.start, end: p.end, conflict: p.conflict })),
      problems: result.report.filter((e) => e.itemId === "preview").slice(0, 4),
      moved,
    });
  });

  r.post("/meetings", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, meetingInput);
    const id = randomUUID();
    const { row, attendees } = rowFrom(
      db,
      user.id,
      id,
      body,
      now(),
      nextRank(db, "meetings", user.id, body.level),
    );
    save(db, row, attendees, true);
    changed(user.id);
    return c.json({ id }, 201);
  });

  r.put("/meetings/:id", async (c) => {
    const user = c.get("user");
    const old = own(c.req.param("id"), user.id);
    const body = await jsonBody(c, meetingInput);
    const { row, attendees } = rowFrom(db, user.id, old.id, body, now(), old.rank);
    save(db, { ...row, created_at: old.created_at }, attendees, false);
    changed(user.id);
    return c.json({ ok: true });
  });

  /** Rule 27 of MEET-02: off removes future occurrences and keeps the rules. */
  r.post("/meetings/:id/enabled", async (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const { enabled } = await jsonBody(c, z.object({ enabled: z.boolean() }));
    run(
      db,
      "UPDATE meetings SET enabled = ?, rules_changed_at = ? WHERE id = ?",
      enabled ? 1 : 0,
      now(),
      m.id,
    );
    changed(user.id);
    return c.json({ ok: true });
  });

  /** MEET-02 rule 20: skip one period; nothing else is placed in it. */
  r.post("/meetings/:id/skip", async (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const { eventId } = await jsonBody(c, z.object({ eventId: z.string() }));
    const key = one<{ key: string }>(
      db,
      "SELECT key FROM managed_events WHERE id = ? AND user_id = ? AND kind = 'meeting' AND source_id = ?",
      eventId,
      user.id,
      m.id,
    )?.key;
    if (!key) notFound("occurrence");
    run(db, "INSERT OR IGNORE INTO dismissed_keys (user_id, key) VALUES (?, ?)", user.id, key);
    changed(user.id);
    return c.json({ ok: true });
  });

  r.delete("/meetings/:id", (c) => {
    const user = c.get("user");
    const m = own(c.req.param("id"), user.id);
    const peers = meetingPeers(db, user.id).attendees;
    run(db, "DELETE FROM meetings WHERE id = ?", m.id);
    sync.request(user.id);
    for (const id of peers) sync.request(id);
    return c.body(null, 204);
  });
  return r;
}
