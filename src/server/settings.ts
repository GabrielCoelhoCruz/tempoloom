// Per-user settings, stored as JSON on the user row. Missing fields take defaults.
import { z } from "zod";
import { type Db, one, run } from "./db.ts";

export const settingsSchema = z.object({
  schedulingWindowWeeks: z.number().int().min(1).max(12).default(3),
  weekStart: z.union([z.literal(1), z.literal(7)]).default(1),
  urgencyMode: z
    .enum(["priority-only", "due-date", "due-date-and-work"])
    .default("due-date-and-work"),
  chunkCooldown: z.enum(["none", "30m", "1h", "2h", "4h", "once-per-day"]).default("none"),
  breakMinutes: z
    .union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30)])
    .default(0),
  paused: z.boolean().default(false),
  taskDefaults: z
    .object({
      level: z.number().int().min(1).max(4).default(2),
      minutes: z.number().int().min(15).default(60),
      splitUp: z.boolean().default(true),
      minChunkMinutes: z.number().int().min(15).default(30),
      maxChunkMinutes: z.number().int().min(15).default(120),
      dueInDays: z.number().int().min(0).nullable().default(3),
      startDelayMinutes: z.number().int().min(0).default(0),
    })
    .prefault({}),
  markers: z
    .object({
      free: z.string().max(8).default("○"),
      busy: z.string().max(8).default("●"),
      locked: z.string().max(8).default("🔒"),
      conflict: z.string().max(8).default("⚠️"),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export function getSettings(db: Db, userId: string): Settings {
  const row = one<{ settings: string }>(db, "SELECT settings FROM users WHERE id = ?", userId);
  const raw: unknown = row ? JSON.parse(row.settings) : {};
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function updateSettings(db: Db, userId: string, patch: unknown): Settings {
  const current = getSettings(db, userId);
  const merged = settingsSchema.parse({
    ...current,
    ...(patch as object),
    taskDefaults: {
      ...current.taskDefaults,
      ...((patch as { taskDefaults?: object }).taskDefaults ?? {}),
    },
    markers: { ...current.markers, ...((patch as { markers?: object }).markers ?? {}) },
  });
  run(db, "UPDATE users SET settings = ? WHERE id = ?", JSON.stringify(merged), userId);
  return merged;
}
