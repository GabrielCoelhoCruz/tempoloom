// Habits (habits-automation.md): create, edit, skip and delete, with their
// guests, auto-decline and dependencies.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import type { HabitFrequency } from "../../scheduler/model.ts";
import { defaultEventSettings, readEventSettings } from "../../shared/event-settings.ts";
import { loopRefusal, type StoredHabit } from "../../shared/habit-loops.ts";
import { utcToLocal } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { editedEventSettings, eventSettingsInput, newEventSettings } from "../event-settings.ts";
import { jsonBody, notFound } from "../http.ts";
import { createItemHours, dropItemHours, itemHoursSchema, saveItemHours } from "../item-hours.ts";
import { automationCount, limitRefusal } from "../limits.ts";
import type { SyncService } from "../sync/service.ts";
import { badRequest, hhmm, hoursSetId, level, minutes, nextRank } from "./items.ts";

/**
 * habits-automation.md "Frequency". `interval` above 1 is the custom frequency;
 * the server sets its `anchor` (see withAnchor).
 */
const cadence = { interval: z.number().int().min(1).max(52).optional() };
const habitFrequency = z.union([
  z.object({ period: z.literal("daily"), ...cadence }),
  z.object({
    period: z.literal("weekly"),
    days: z.array(z.number().int().min(1).max(7)).min(1),
    ...cadence,
  }),
  z.object({
    period: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
    ...cadence,
  }),
  z.object({
    period: z.literal("monthly"),
    nth: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal("last"),
    ]),
    weekday: z.number().int().min(1).max(7),
    ...cadence,
  }),
]);

/**
 * Interval 1 is the plain frequency: no interval, no anchor. A new interval
 * gets the anchor of the stored frequency, else the start date, else today;
 * the anchor then stays, so a later start date (a snooze) keeps the cadence.
 */
export function withAnchor(
  next: z.infer<typeof habitFrequency>,
  stored: HabitFrequency | null,
  starting: string | null,
  today: string,
): HabitFrequency {
  const { interval, ...base } = next;
  if (!interval || interval <= 1) return base;
  const anchor =
    (stored?.interval ?? 1) > 1 && stored?.anchor ? stored.anchor : (starting ?? today);
  return { ...base, interval, anchor };
}

const habitInput = z.object({
  title: z.string().trim().min(1).max(255),
  notes: z.string().max(10_000).optional(),
  enabled: z.boolean().optional(),
  level: level.optional(),
  hoursSetId: z.string().optional(),
  idealTime: hhmm,
  /** The ideal start is the end of each day's hours minus the length (`ideal_at_end`). */
  idealAtEnd: z.boolean().optional(),
  minMinutes: minutes,
  maxMinutes: minutes,
  frequency: habitFrequency.optional(),
  starting: z.iso.date().nullable().optional(),
  defense: z.enum(["adaptive", "always-free", "always-busy"]).optional(),
  whenUnplaceable: z.enum(["remove", "keep_as_conflict"]).optional(),
  reservedWords: z.array(z.string().max(100)).max(20).optional(),
  eventSettings: eventSettingsInput.optional(),
  /** The library entry it came from (automations-library.md rule 4). */
  templateId: z.string().max(100).optional(),
  /** Item-specific hours instead of a named set (planning-hours.md). */
  itemHours: itemHoursSchema.optional(),
  /** Attendees of each event; no availability check, no notices (habits concepts). */
  guests: z.array(z.email().max(254)).max(50).optional(),
  /** Habits rules 37-39. */
  autoDecline: z.object({ enabled: z.boolean(), message: z.string().trim().max(500) }).optional(),
  /** Habits rule 18, meetings-flexible.md rule 22. */
  dependencies: z
    .array(
      z.object({
        rule: z.enum(["before", "not-after", "not-same-day"]),
        kind: z.enum(["habit", "meeting"]),
        id: z.string().min(1),
      }),
    )
    .max(20)
    .optional(),
});

export function habitRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const changed = (userId: string) => sync.request(userId);
  const personalHours = (userId: string, hours: string) =>
    one<{ kind: string }>(
      db,
      "SELECT kind FROM hours_sets WHERE id = ? AND user_id = ?",
      hours,
      userId,
    )?.kind === "personal";

  const habitRow = (id: string) =>
    one<Record<string, unknown>>(db, "SELECT * FROM habits WHERE id = ?", id);

  function checkHabit(
    userId: string,
    body: { idealTime: string; minMinutes: number; maxMinutes: number },
    hours: string,
  ): number {
    if (body.minMinutes > body.maxMinutes)
      badRequest("minMinutes", "Minimum is longer than maximum");
    const [h, m] = body.idealTime.split(":").map(Number) as [number, number];
    const ideal = h * 60 + m;
    const weekly = JSON.parse(
      one<{ weekly: string }>(
        db,
        "SELECT weekly FROM hours_sets WHERE id = ? AND user_id = ?",
        hours,
        userId,
      )?.weekly ?? "{}",
    ) as WeeklyHours;
    const inside = Object.values(weekly).some((ranges) =>
      ranges?.some(([s, e]) => ideal >= s && ideal < e),
    );
    if (!inside)
      badRequest("idealTime", "The ideal time is outside the habit's hours on every day");
    return ideal;
  }

  /** Guests in lower case, once each. */
  const guestList = (guests: string[]) => [...new Set(guests.map((g) => g.toLowerCase()))];

  /**
   * Rule 18: targets are the user's other habits and flexible meetings; one
   * rule per target. A rule on a target that was deleted since is dropped. A
   * rule that closes a loop of habit rules is refused: the habits of a loop
   * cannot all go first.
   */
  function checkDependencies(
    userId: string,
    habitId: string,
    deps: NonNullable<z.infer<typeof habitInput>["dependencies"]>,
  ): string {
    const seen = new Set<string>();
    const kept = deps.filter((d) =>
      one(
        db,
        `SELECT 1 FROM ${d.kind === "habit" ? "habits" : "meetings"} WHERE id = ? AND user_id = ?`,
        d.id,
        userId,
      ),
    );
    const stored = all<StoredHabit>(
      db,
      "SELECT id, title, dependencies FROM habits WHERE user_id = ?",
      userId,
    );
    for (const d of kept) {
      const target = `${d.kind}:${d.id}`;
      if (seen.has(target)) badRequest("dependencies", "Give each habit or meeting one rule only");
      seen.add(target);
      if (d.kind === "habit" && d.id === habitId)
        badRequest("dependencies", "A habit cannot depend on itself");
      if (d.kind === "meeting" && d.rule === "not-same-day")
        badRequest("dependencies", "A meeting rule is before or not after the meeting");
      const loop = d.kind === "habit" ? loopRefusal(stored, habitId, d.id) : null;
      if (loop) badRequest("dependencies", loop);
    }
    return JSON.stringify(kept);
  }

  r.get("/habits", (c) =>
    c.json({
      habits: all(
        db,
        `SELECT h.*, CASE WHEN s.item_specific = 1 THEN s.weekly END AS item_hours
         FROM habits h JOIN hours_sets s ON s.id = h.hours_set_id
         WHERE h.user_id = ? ORDER BY h.level, h.rank, h.created_at`,
        c.get("user").id,
      ),
    }),
  );

  r.post("/habits", async (c) => {
    const user = c.get("user");
    const full = limitRefusal(db, "max_automations_per_user", automationCount(db, user.id));
    if (full) return c.json(full, 409);
    const body = await jsonBody(c, habitInput);
    const id = randomUUID();
    const deps = checkDependencies(user.id, id, body.dependencies ?? []);
    const hours = body.itemHours
      ? createItemHours(db, user.id, body.title, body.itemHours)
      : hoursSetId(db, user.id, body.hoursSetId, "work");
    let ideal: number;
    try {
      ideal = checkHabit(user.id, body, hours);
    } catch (err) {
      if (body.itemHours) dropItemHours(db, hours);
      throw err;
    }
    const lvl = body.level ?? 3;
    const t = now();
    const es = newEventSettings(db, user.id, "habit", body.eventSettings, {
      personal: personalHours(user.id, hours),
    });
    run(
      db,
      `INSERT INTO habits (id, user_id, title, notes, enabled, level, rank, hours_set_id, ideal_minute, min_minutes,
         max_minutes, frequency, starting, defense, when_unplaceable, reserved_words, created_at, rules_changed_at,
         event_settings, template_id, guests, decline_enabled, decline_message, dependencies, ideal_at_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      body.title,
      body.notes ?? "",
      body.enabled === false ? 0 : 1,
      lvl,
      nextRank(db, "habits", user.id, lvl),
      hours,
      ideal,
      body.minMinutes,
      body.maxMinutes,
      JSON.stringify(
        body.frequency
          ? withAnchor(
              body.frequency,
              null,
              body.starting ?? null,
              utcToLocal(user.time_zone, t).date,
            )
          : { period: "daily" },
      ),
      body.starting ?? null,
      body.defense ?? "adaptive",
      body.whenUnplaceable ?? "keep_as_conflict",
      JSON.stringify(body.reservedWords ?? []),
      t,
      t,
      JSON.stringify(es),
      body.templateId ?? null,
      JSON.stringify(guestList(body.guests ?? [])),
      body.autoDecline?.enabled ? 1 : 0,
      body.autoDecline?.message ?? "",
      deps,
      body.idealAtEnd ? 1 : 0,
    );
    changed(user.id);
    return c.json({ habit: habitRow(id) }, 201);
  });

  r.patch("/habits/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const cur = one<{
      title: string;
      notes: string;
      enabled: number;
      level: number;
      rank: number;
      hours_set_id: string;
      ideal_minute: number;
      min_minutes: number;
      max_minutes: number;
      frequency: string;
      starting: string | null;
      defense: string;
      when_unplaceable: string;
      reserved_words: string;
      event_settings: string;
      guests: string;
      decline_enabled: number;
      decline_message: string;
      dependencies: string;
      ideal_at_end: number;
    }>(db, "SELECT * FROM habits WHERE id = ? AND user_id = ?", id, user.id);
    if (!cur) notFound("habit");
    const body = await jsonBody(c, habitInput.partial());
    const deps = body.dependencies
      ? checkDependencies(user.id, id, body.dependencies)
      : cur.dependencies;
    const hours = body.itemHours
      ? saveItemHours(db, user.id, cur.hours_set_id, body.title ?? cur.title, body.itemHours)
      : body.hoursSetId
        ? hoursSetId(db, user.id, body.hoursSetId, "work")
        : cur.hours_set_id;
    const idealTime =
      body.idealTime ??
      `${String(Math.floor(cur.ideal_minute / 60)).padStart(2, "0")}:${String(cur.ideal_minute % 60).padStart(2, "0")}`;
    const ideal = checkHabit(
      user.id,
      {
        idealTime,
        minMinutes: body.minMinutes ?? cur.min_minutes,
        maxMinutes: body.maxMinutes ?? cur.max_minutes,
      },
      hours,
    );
    const es = editedEventSettings(
      readEventSettings(
        cur.event_settings,
        defaultEventSettings("habit", { personal: personalHours(user.id, cur.hours_set_id) }),
      ),
      body.eventSettings,
    );
    run(
      db,
      `UPDATE habits SET title = ?, notes = ?, enabled = ?, level = ?, hours_set_id = ?, ideal_minute = ?, min_minutes = ?,
         max_minutes = ?, frequency = ?, starting = ?, defense = ?, when_unplaceable = ?, reserved_words = ?,
         rules_changed_at = ?, event_settings = ?, rank = ?, guests = ?, decline_enabled = ?,
         decline_message = ?, dependencies = ?, ideal_at_end = ? WHERE id = ?`,
      body.title ?? cur.title,
      body.notes ?? cur.notes,
      body.enabled === undefined ? cur.enabled : body.enabled ? 1 : 0,
      body.level ?? cur.level,
      hours,
      ideal,
      body.minMinutes ?? cur.min_minutes,
      body.maxMinutes ?? cur.max_minutes,
      body.frequency
        ? JSON.stringify(
            withAnchor(
              body.frequency,
              JSON.parse(cur.frequency) as HabitFrequency,
              body.starting === undefined ? cur.starting : body.starting,
              utcToLocal(user.time_zone, now()).date,
            ),
          )
        : cur.frequency,
      body.starting === undefined ? cur.starting : body.starting,
      body.defense ?? cur.defense,
      body.whenUnplaceable ?? cur.when_unplaceable,
      body.reservedWords ? JSON.stringify(body.reservedWords) : cur.reserved_words,
      now(),
      JSON.stringify(es),
      // A new priority puts the habit at the end of its new group (automations-overview rule 7).
      body.level !== undefined && body.level !== cur.level
        ? nextRank(db, "habits", user.id, body.level)
        : cur.rank,
      body.guests ? JSON.stringify(guestList(body.guests)) : cur.guests,
      body.autoDecline ? (body.autoDecline.enabled ? 1 : 0) : cur.decline_enabled,
      body.autoDecline ? body.autoDecline.message : cur.decline_message,
      deps,
      body.idealAtEnd === undefined ? cur.ideal_at_end : body.idealAtEnd ? 1 : 0,
      id,
    );
    if (hours !== cur.hours_set_id) dropItemHours(db, cur.hours_set_id);
    changed(user.id);
    return c.json({ habit: habitRow(id) });
  });

  r.post("/habits/:id/skip", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const { date } = await jsonBody(c, z.object({ date: z.iso.date() }));
    if (!one(db, "SELECT 1 FROM habits WHERE id = ? AND user_id = ?", id, user.id))
      notFound("habit");
    run(
      db,
      "INSERT OR IGNORE INTO dismissed_keys (user_id, key) VALUES (?, ?)",
      user.id,
      `habit:${id}:${date}`,
    );
    changed(user.id);
    return c.json({ ok: true });
  });

  r.delete("/habits/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const own = one<{ hours_set_id: string }>(
      db,
      "SELECT hours_set_id FROM habits WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    if (!own) notFound("habit");
    // Future events go with the next plan; past events stay (habit spec rule 36).
    tx(db, () => {
      run(
        db,
        "DELETE FROM item_exclusions WHERE user_id = ? AND kind = 'habit' AND item_id = ?",
        user.id,
        id,
      );
      run(db, "DELETE FROM habits WHERE id = ?", id);
      dropItemHours(db, own.hours_set_id);
    });
    changed(user.id);
    return c.body(null, 204);
  });

  return r;
}
