// Input and output of the scheduling engine (docs/specs/planning-scheduler.md).
// All times are epoch milliseconds. Durations are minutes.
import type { LocalDate } from "../shared/time.ts";
import type { WeeklyHours } from "./hours.ts";
import type { Interval } from "./timeset.ts";

export type Level = 1 | 2 | 3 | 4;
export type UrgencyMode = "priority-only" | "due-date" | "due-date-and-work";
export type ChunkCooldown = "none" | "30m" | "1h" | "2h" | "4h" | "once-per-day";
export type HabitDefense = "adaptive" | "always-free" | "always-busy";
export type WhenUnplaceable = "remove" | "keep_as_conflict";

export interface ExternalEvent {
  id: string;
  start: number;
  end: number;
  allDay: boolean;
  busy: boolean;
  title: string;
  description: string;
  /** null: no attendee list (the user's own event). */
  selfResponse: "needsAction" | "declined" | "tentative" | "accepted" | null;
  organizerSelf: boolean;
  attendeeCount: number;
  location: string;
  eventType: string;
  bookedViaLink: boolean;
}

/** An existing managed event. */
export interface CurrentPlacement {
  key: string;
  itemId: string;
  start: number;
  end: number;
  locked: boolean;
}

export interface TaskItem {
  id: string;
  title: string;
  level: Level;
  remainingMinutes: number;
  minChunkMinutes: number;
  maxChunkMinutes: number;
  startAfter: number;
  dueAt: number | null;
  hours: string;
  /** Position in the next-up queue, or null. */
  nextUpRank: number | null;
  createdAt: number;
  /** Ranges the task must never use (deleted chunks). */
  exclusions: Interval[];
  /** True when the user changed the task's rules since the last run (no stickiness). */
  changed: boolean;
}

export interface HabitItem {
  id: string;
  title: string;
  level: Level;
  rank: number;
  createdAt: number;
  /** Hours set id; the habit's window. */
  hours: string;
  idealMinute: number;
  minMinutes: number;
  maxMinutes: number;
  frequency: { period: "daily" } | { period: "weekly"; days: number[] };
  starting: LocalDate | null;
  defense: HabitDefense;
  whenUnplaceable: WhenUnplaceable;
  reservedWords: string[];
  /** Occurrence dates the user skipped. */
  skips: LocalDate[];
  exclusions: Interval[];
  changed: boolean;
}

export interface BufferFilter {
  text?: { values: string[]; fields: ("title" | "description" | "location")[] };
  participants?: { op: ">=" | "<=" | "="; value: number };
  length?: { op: ">=" | "<=" | "="; minutes: number };
  exactTitle?: string;
  tags?: string[];
}

export interface BufferItem {
  id: string;
  title: string;
  level: Level;
  rank: number;
  createdAt: number;
  side: "before" | "after" | "both";
  minutesBefore: number;
  minutesAfter: number;
  busy: boolean;
  filter: BufferFilter;
  onConflict: WhenUnplaceable;
  changed: boolean;
}

export interface FocusItem {
  id: string;
  title: string;
  rank: number;
  createdAt: number;
  hours: string;
  weeklyGoalMinutes: number;
  dailyMinMinutes: number;
  dailyMaxMinutes: number;
  minBlockMinutes: number;
  maxBlockMinutes: number;
  busy: boolean;
  /** Ranges the user deleted; never used again. */
  exclusions: Interval[];
  changed: boolean;
}

export interface Snapshot {
  now: number;
  zone: string;
  /** ISO weekday of the first day of the week. */
  weekStart: 1 | 7;
  windowEnd: number;
  stepMinutes: number;
  urgencyMode: UrgencyMode;
  chunkCooldown: ChunkCooldown;
  breakMinutes: number;
  hours: Record<string, WeeklyHours>;
  /** Hours sets whose tasks and habits count toward the focus goal. */
  workHours: string[];
  events: ExternalEvent[];
  /** Existing managed events that have not ended. */
  current: CurrentPlacement[];
  /** Managed events that ended in the current week: done habit occurrences and focus credit. */
  past?: CurrentPlacement[];
  /** Demand keys the user dismissed (deleted buffers); never placed again. */
  dismissedKeys?: string[];
  tasks: TaskItem[];
  habits: HabitItem[];
  buffers: BufferItem[];
  focus: FocusItem[];
}

export type PlacementKind = "task" | "habit" | "buffer" | "focus";

export interface Placement {
  key: string;
  kind: PlacementKind;
  itemId: string;
  start: number;
  end: number;
  busy: boolean;
  locked: boolean;
  conflict: boolean;
  /** For tasks: true when this chunk ends after the due date. */
  afterDue: boolean;
}

export type ReasonCode =
  | "outside-window"
  | "no-hours"
  | "too-long-for-hours"
  | "all-day-block"
  | "reserved-word"
  | "no-space-fixed"
  | "no-space-priority"
  | "after-due";

export interface ReportEntry {
  itemKind: PlacementKind;
  itemId: string;
  demandKey: string;
  requiredMinutes: number;
  placedMinutes: number;
  missingMinutes: number;
  status: "unplaced" | "partial" | "after-due" | "conflict";
  reason: ReasonCode;
}

export interface Plan {
  placements: Placement[];
  report: ReportEntry[];
}
