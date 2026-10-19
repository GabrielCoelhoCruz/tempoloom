// Per-user meeting preferences: meeting checks and their digest
// (automations-meeting-quality.md), meeting emails (planning-notifications.md
// NTF-20 to NTF-30, meetings-flexible-rescheduling.md rule 35) and meeting
// start-time intervals (meetings-start-intervals.md) and the weekly report email
// (analytics-weekly-reports.md). Missing fields take defaults.
import { z } from "zod";
import { type Db, one, run } from "./db.ts";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const CHECK_IDS = [
  "conflict",
  "attendee_availability",
  "rsvp_reminder",
  "video_link",
  "agenda",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const prefsSchema = z.object({
  /** Rule 1: the four built-in checks are on for a new user; agenda drafts (library entry 4) are off. */
  checks: z
    .object({
      conflict: z.boolean().default(true),
      attendee_availability: z.boolean().default(true),
      rsvp_reminder: z.boolean().default(true),
      video_link: z.boolean().default(true),
      agenda: z.boolean().default(false),
    })
    .prefault({}),
  /** The daily digest of open issues: by email, or off. A chat app needs a vendor app. */
  digest: z.enum(["email", "none"]).default("email"),
  digestTime: hhmm.default("08:00"),
  meetingChangeEmails: z.boolean().default(true),
  meetingChangeDaysAhead: z.number().int().min(0).max(30).default(7),
  atRiskDigest: z.boolean().default(true),
  newSeriesEmail: z.boolean().default(true),
  /** The weekly report email (analytics-weekly-reports.md rules 1-2): on for a new user. */
  weeklyReport: z.boolean().default(true),
  /** The time of the at-risk digest and the new recurring meeting email. */
  dailyTime: hhmm.default("07:00"),
  /** Library entries of kind meeting_check the user added (automations-library.md rule 4). */
  libraryEntries: z.array(z.string().max(100)).max(50).default([]),
  /** Minutes of the hour at which meetings may start (MEET-03 rule 1: never empty). */
  startMinutes: z
    .array(z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]))
    .min(1, "Keep at least one start time.")
    .transform((m) => [...new Set(m)].sort((a, b) => a - b))
    .default([0, 15, 30, 45]),
});

export type MeetingPrefs = z.infer<typeof prefsSchema>;

export function getPrefs(db: Db, userId: string): MeetingPrefs {
  const raw = one<{ prefs: string }>(
    db,
    "SELECT prefs FROM meeting_prefs WHERE user_id = ?",
    userId,
  );
  const parsed = prefsSchema.safeParse(raw ? JSON.parse(raw.prefs) : {});
  return parsed.success ? parsed.data : prefsSchema.parse({});
}

/** Merges a partial change; throws a ZodError for invalid values. */
export function updatePrefs(db: Db, userId: string, patch: Record<string, unknown>): MeetingPrefs {
  const current = getPrefs(db, userId);
  const next = prefsSchema.parse({
    ...current,
    ...patch,
    checks: { ...current.checks, ...((patch.checks as object | undefined) ?? {}) },
  });
  run(
    db,
    `INSERT INTO meeting_prefs (user_id, prefs) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET prefs = excluded.prefs`,
    userId,
    JSON.stringify(next),
  );
  return next;
}
