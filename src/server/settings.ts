// Per-user settings, stored as JSON on the user row. Missing fields take defaults.
import { z } from "zod";
import { CATEGORIES } from "../scheduler/categories.ts";

/** One of Google's 11 event colors, or the calendar's own color. */
const eventColor = z.enum([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "calendar_default",
]);

import { COMPANY_SIZES, USE_CASES } from "../shared/profile.ts";
import { type Db, one, run } from "./db.ts";
import { instanceLimit } from "./limits.ts";

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
      // events-title-emoji.md marker table: events that ended.
      done: z.string().max(8).default("✅"),
      partial: z.string().max(8).default("👍"),
    })
    .prefault({}),
  // events-categories-and-colors.md: color settings with the proposed defaults.
  colorScope: z.enum(["managed_only", "all_events"]).default("managed_only"),
  categoryColors: z
    .object(
      Object.fromEntries(CATEGORIES.map((c) => [c, eventColor])) as Record<
        (typeof CATEGORIES)[number],
        typeof eventColor
      >,
    )
    .partial()
    .transform((m) => ({ ...DEFAULT_COLORS, ...m }))
    .prefault({}),
  // r3 s3: task placement (planning-tasks.md TSK-70), in-app alerts
  // (planning-notifications.md), first-run hours review (HRS-15), profile fields.
  taskPlacement: z.enum(["chunks", "suggestions"]).default("chunks"),
  // sync-calendar-mirroring.md account-level setting: copies of events with no reply.
  noReplyCopies: z.enum(["free", "busy"]).default("free"),
  tabAlert: z.boolean().default(true),
  startChime: z.boolean().default(false),
  hoursReviewed: z.boolean().default(false),
  profile: z
    .object({
      jobTitle: z.string().trim().max(100).default(""),
      company: z.string().trim().max(100).default(""),
      companySize: z.enum(["", ...COMPANY_SIZES]).default(""),
      useCase: z.enum(["", ...USE_CASES]).default(""),
    })
    .prefault({}),
});

const DEFAULT_COLORS: Record<(typeof CATEGORIES)[number], z.infer<typeof eventColor>> = {
  team_meeting: "9",
  one_on_one: "7",
  external_meeting: "11",
  solo_work: "2",
  personal: "3",
  travel: "5",
  flight: "5",
  vacation: "8",
  personal_commitment: "8",
};

export type Settings = z.infer<typeof settingsSchema>;

function storedSettings(db: Db, userId: string): Settings {
  const row = one<{ settings: string }>(db, "SELECT settings FROM users WHERE id = ?", userId);
  const raw: unknown = row ? JSON.parse(row.settings) : {};
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function getSettings(db: Db, userId: string): Settings {
  const settings = storedSettings(db, userId);
  // An instance limit caps the planning window; the user's own value comes back without it.
  const limit = instanceLimit(db, "max_scheduling_window_weeks");
  return limit !== null && settings.schedulingWindowWeeks > limit
    ? { ...settings, schedulingWindowWeeks: limit }
    : settings;
}

export function updateSettings(db: Db, userId: string, patch: unknown): Settings {
  const current = storedSettings(db, userId);
  const merged = settingsSchema.parse({
    ...current,
    ...(patch as object),
    taskDefaults: {
      ...current.taskDefaults,
      ...((patch as { taskDefaults?: object }).taskDefaults ?? {}),
    },
    markers: { ...current.markers, ...((patch as { markers?: object }).markers ?? {}) },
    categoryColors: {
      ...current.categoryColors,
      ...((patch as { categoryColors?: object }).categoryColors ?? {}),
    },
    profile: { ...current.profile, ...((patch as { profile?: object }).profile ?? {}) },
  });
  run(db, "UPDATE users SET settings = ? WHERE id = ?", JSON.stringify(merged), userId);
  return merged;
}
