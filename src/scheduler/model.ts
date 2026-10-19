// Input and output of the scheduling engine (docs/specs/planning-scheduler.md).
// All times are epoch milliseconds. Durations are minutes.
import type { LocalDate } from "../shared/time.ts";
import type { Category } from "./categories.ts";
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
  /** events-categories-and-colors.md; unknown when not given. */
  category?: Category;
  /** The calendar that holds the event (buffer calendar scope). */
  calendarId?: string;
  /** Attendee emails, lower case (buffer filter by person). */
  attendees?: string[];
  /** For a Tempoloom mirror copy: the calendar of its source event. */
  mirrorSource?: string;
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
  frequency: HabitFrequency;
  starting: LocalDate | null;
  defense: HabitDefense;
  whenUnplaceable: WhenUnplaceable;
  reservedWords: string[];
  /** Occurrence dates the user skipped. */
  skips: LocalDate[];
  exclusions: Interval[];
  changed: boolean;
  /** Occurrence date -> the time of day the user chose for it (habits rule 30). */
  rescheduled?: Partial<Record<LocalDate, number>>;
  /** Category work or personal (habits concepts); missing: it counts as work when its hours are work hours. */
  work?: boolean;
}

/** habits-automation.md "Frequency"; weekday 1 is Monday. */
export type HabitFrequency =
  | { period: "daily" }
  | { period: "weekly"; days: number[] }
  | { period: "monthly"; dayOfMonth: number }
  | { period: "monthly"; nth: 1 | 2 | 3 | 4 | 5 | "last"; weekday: number };

/** A flexible meeting (docs/specs/meetings-flexible.md); the user is the organizer. */
export interface MeetingItem {
  id: string;
  title: string;
  level: Level;
  rank: number;
  createdAt: number;
  /** The organizer's hours set id. */
  hours: string;
  /** Time that suits every required attendee who is a user here; null: no limit (rule 11). */
  attendeeWindow: Interval[] | null;
  /** Time when a required attendee is busy (rule 13). */
  attendeeBusy: Interval[];
  idealMinute: number;
  /** Daily: one per day. Weekly: one per N weeks, counted from `starting`. */
  frequency: { period: "daily" } | { period: "weekly"; everyWeeks: number; idealDays: number[] };
  durationMinutes: number;
  /** The shortest length the meeting may shrink to (rule 17). */
  shortestMinutes: number;
  starting: LocalDate | null;
  defense: "adaptive" | "busy" | "free";
  whenUnplaceable: WhenUnplaceable;
  /** An automatic move never starts sooner than this after now (MEET-02 rule 8). */
  leadMinutes: number;
  exclusions: Interval[];
  changed: boolean;
  /** Automatic moves allowed per 24 hours (MEET-02 rule 9); 0: never. Unset: no limit. */
  moveLimit?: number;
  /** Automatic moves left now in the rolling 24 hours. */
  movesLeft?: number;
  /** Minutes of the hour a new start may use, in `zone` (meetings-start-intervals.md). */
  startMinutes?: number[];
  /** An adopted series: only these periods (start dates) have an instance to place. */
  periods?: LocalDate[];
}

export type Comparison = ">=" | "<=" | "=" | ">" | "<";

export interface BufferFilter {
  text?: { values: string[]; fields: ("title" | "description" | "location")[] };
  participants?: { op: Comparison; value: number };
  length?: { op: Comparison; minutes: number };
  exactTitle?: string;
  tags?: string[];
  /** Travel time: a physical address (two or more commas) or #tl_travel, and not a flight. */
  travel?: boolean;
  /** Airport time: #tl_flight or a flight number in the title. */
  flight?: boolean;
  /** Event categories (events-categories-and-colors.md rule 14). */
  categories?: Category[];
  /** Attendee or organizer emails, or "@domain" for anyone at a domain. */
  people?: string[];
  /** The anchor is a run of back-to-back matching events longer than this. */
  runLongerThanMinutes?: number;
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
  /** One calendar id, or null (or absent) for all calendars. */
  calendarScope?: string | null;
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
  /** focus-time.md rules 1-10; proactive when absent. */
  mode?: "proactive" | "reactive";
}

/** The meeting overload automation (focus-time.md rules 11-16); its events are focus events. */
export interface OverloadItem {
  id: string;
  title: string;
  /** Its rank inside P4, shared with focus goals (automations-overview.md rule 8). */
  rank: number;
  createdAt: number;
  hours: string;
  dailyMaxMinutes: number | null;
  weeklyMaxMinutes: number | null;
  /** The daily limit applies only on a workday after a day with this many meeting minutes. */
  heavyDayMinutes: number | null;
  minBlockMinutes: number;
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
  meetings: MeetingItem[];
  buffers: BufferItem[];
  focus: FocusItem[];
  overloads?: OverloadItem[];
  /** Tempoloom's own mirror copies, as their calendars show them; buffer anchors only. */
  mirrorCopies?: ExternalEvent[];
  /**
   * A fragmentation policy (teams-policies.md rule 23): new habits and flexible
   * meetings prefer slots that leave no gap shorter than `minBlockMinutes`
   * between busy times, and move at most `maxShiftMinutes` from their ideal time
   * for it.
   */
  fragmentation?: { minBlockMinutes: number; maxShiftMinutes: number };
}

export type PlacementKind = "task" | "habit" | "meeting" | "buffer" | "focus";

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
  | "no-hours-overlap"
  | "too-long-for-hours"
  | "all-day-block"
  | "reserved-word"
  | "no-space-fixed"
  | "no-space-priority"
  | "after-due"
  | "budget-reached"
  | "policy-none";

export interface ReportEntry {
  itemKind: PlacementKind;
  itemId: string;
  demandKey: string;
  requiredMinutes: number;
  placedMinutes: number;
  missingMinutes: number;
  status: "unplaced" | "partial" | "after-due" | "conflict";
  reason: ReasonCode;
  /** A flagged meeting occurrence: up to 3 other times (MEET-02 rule 11). */
  suggestions?: Interval[];
}

export interface Plan {
  placements: Placement[];
  report: ReportEntry[];
}
