import type { Category } from "../../scheduler/categories.ts";
import type { ItemRange } from "../../shared/item-hours.ts";

// The automation library (docs/specs/automations-library.md): ready-made
// starting points. All presets are Tempoloom's own proposals (spec, "Entries").

export type LibraryGroup =
  | "habits"
  | "buffers"
  | "focus_time"
  | "flexible_meetings"
  | "meeting_checks"
  | "other"
  | "prompts";

export const GROUP_NAMES: Record<LibraryGroup, string> = {
  habits: "Habits",
  buffers: "Buffers",
  focus_time: "Focus time",
  flexible_meetings: "Flexible meetings",
  meeting_checks: "Meeting checks",
  other: "Other",
  prompts: "Prompts",
};

export interface HabitPreset {
  idealTime: string;
  minutes: number;
  /** ISO weekdays; null: every day of its hours. */
  days: number[] | null;
  level: 1 | 2 | 3 | 4;
  hours: "work" | "personal";
  /** Item-specific hours on these days instead of a named set. */
  window?: ItemRange;
  /** The ideal time is the last `minutes` of work hours, read from the user's work hours. */
  idealAtEnd?: boolean;
}

const WORKDAYS = [1, 2, 3, 4, 5];

export interface BufferPreset {
  side: "before" | "after" | "both";
  minutesBefore?: number;
  minutesAfter?: number;
  level?: 1 | 2 | 3 | 4;
  busy?: boolean;
  filter: {
    text?: { values: string[]; fields: ("title" | "description" | "location")[] };
    participants?: { op: ">=" | "<=" | "="; value: number };
    length?: { op: ">=" | "<=" | "="; minutes: number };
    travel?: boolean;
    flight?: boolean;
    categories?: Category[];
    people?: string[];
    runLongerThanMinutes?: number;
  };
}

export interface MeetingOverloadPreset {
  dailyMaxHours?: number;
  weeklyMaxHours?: number;
  heavyDayHours?: number;
}

export interface FocusPreset {
  weeklyGoalMinutes: number;
  minBlockMinutes?: number;
  /** The ideal window, as item-specific hours (focus-time.md `hours`: a one-off window). */
  window?: ItemRange;
}

export interface MeetingPreset {
  everyWeeks: number;
  durationMinutes: number;
  level: 1 | 2 | 3 | 4;
}

export interface MeetingCheckPreset {
  /** Checks the entry turns on (automations-meeting-quality.md). */
  checks: ("conflict" | "attendee_availability" | "rsvp_reminder" | "video_link" | "agenda")[];
  digest?: "email";
}

export interface LinkPreset {
  durations: string;
  level: 1 | 2 | 3 | 4;
}

export type LibraryEntry = {
  slug: string;
  name: string;
  group: LibraryGroup;
  summary: string;
  /** An emoji the entry puts before the title; the form can remove it (events-title-emoji.md rule 4). */
  emoji?: string;
} & (
  | { kind: "habit"; preset: HabitPreset }
  /** `form`: the entry opens the buffer form, because the user must add something (edge case 1). */
  | { kind: "buffer"; preset: BufferPreset; form?: boolean }
  | { kind: "meeting_overload"; preset: MeetingOverloadPreset }
  | { kind: "focus_time"; preset: FocusPreset }
  | { kind: "flexible_meeting"; preset: MeetingPreset }
  | { kind: "booking_link"; preset: LinkPreset }
  | { kind: "calendar_mirroring"; preset: { visibility: "busy_only" } }
  | { kind: "meeting_check"; preset: MeetingCheckPreset }
  | { kind: "no_meeting_day"; preset: { weekday: number } }
  /** Kinds Tempoloom does not have yet; the reason says what is missing. */
  | { kind: "unavailable"; reason: string }
);

const NEEDS_ASSISTANT = "Needs the assistant chat, which Tempoloom does not have yet.";
const prompt = (slug: string, name: string, summary: string): LibraryEntry => ({
  slug,
  name,
  group: "prompts",
  summary,
  kind: "unavailable",
  reason: NEEDS_ASSISTANT,
});

export const LIBRARY: LibraryEntry[] = [
  {
    slug: "recovery-large-meetings",
    name: "Recovery after large meetings",
    emoji: "☕",
    group: "buffers",
    summary: "15 min after meetings with 6 or more people. P3, busy.",
    kind: "buffer",
    preset: {
      side: "after",
      minutesAfter: 15,
      level: 3,
      busy: true,
      filter: { participants: { op: ">=", value: 6 } },
    },
  },
  {
    slug: "prep-executive-meetings",
    name: "Prep before executive meetings",
    group: "buffers",
    summary: "15 min before meetings with chosen people. P2.",
    kind: "buffer",
    form: true,
    preset: { side: "before", minutesBefore: 15, level: 2, busy: true, filter: { people: [] } },
  },
  {
    slug: "prep-interviews",
    name: "Prep before interviews",
    emoji: "📝",
    group: "buffers",
    summary: 'Prep 15 min before events with "interview" in the title. P2.',
    kind: "buffer",
    preset: {
      side: "before",
      minutesBefore: 15,
      level: 2,
      filter: { text: { values: ["interview"], fields: ["title"] } },
    },
  },
  {
    slug: "agenda-drafts",
    name: "Agenda drafts for my meetings",
    group: "meeting_checks",
    summary: "Draft agendas for your meetings without a description.",
    kind: "meeting_check",
    preset: { checks: ["agenda"] },
  },
  prompt("back-plan", "Back-plan work from due dates", "Propose work time before each due date."),
  prompt("what-now", "What to do now", "Which task to start now, and why."),
  {
    slug: "executive-focus",
    name: "Executive weekly focus",
    emoji: "🎯",
    group: "focus_time",
    summary: "8 h of focus time each week, in the mornings (09:00 to 12:00).",
    kind: "focus_time",
    preset: { weeklyGoalMinutes: 480, window: { days: WORKDAYS, from: "09:00", to: "12:00" } },
  },
  {
    slug: "recovery-day",
    name: "Recovery day after heavy meeting days",
    group: "other",
    summary: "After 5 h of meetings, cap the next workday at 2 h.",
    kind: "meeting_overload",
    preset: { dailyMaxHours: 2, heavyDayHours: 5 },
  },
  {
    slug: "flag-meeting-problems",
    name: "Flag meeting problems",
    group: "meeting_checks",
    summary: "Daily check for conflicts, missing answers and missing video links.",
    kind: "meeting_check",
    preset: {
      checks: ["conflict", "attendee_availability", "rsvp_reminder", "video_link"],
      digest: "email",
    },
  },
  {
    slug: "airport-travel",
    name: "Airport travel time",
    group: "buffers",
    summary: "120 min before and 60 min after flights.",
    kind: "buffer",
    preset: { side: "both", minutesBefore: 120, minutesAfter: 60, filter: { flight: true } },
  },
  {
    slug: "wrap-up",
    name: "End-of-day wrap-up",
    emoji: "🌇",
    group: "habits",
    summary: "30 min, Monday to Friday, in the last 30 min of work hours. P3.",
    kind: "habit",
    preset: {
      idealTime: "16:30",
      idealAtEnd: true,
      minutes: 30,
      days: null,
      level: 3,
      hours: "work",
    },
  },
  prompt(
    "customer-onboarding",
    "Customer onboarding meeting plan",
    "Plan a kickoff, a check-in after 1 week and a review after 30 days.",
  ),
  {
    slug: "prep-customer-meetings",
    name: "Prep before customer meetings",
    group: "buffers",
    summary: "15 min before external meetings. P2.",
    kind: "buffer",
    preset: {
      side: "before",
      minutesBefore: 15,
      level: 2,
      filter: { categories: ["external_meeting"] },
    },
  },
  prompt("work-rhythm", "Work rhythm review", "When do you do deep work, and when do you meet?"),
  prompt("cross-team", "Cross-team meeting time", "Find the best time this week for colleagues."),
  prompt("burnout", "Burnout risk review", "Check the last 4 weeks for burnout signs."),
  prompt("team-health", "Team meeting health review", "Summarize the team's meeting load."),
  prompt("urgent-review", "Urgent review meeting", "Find the earliest slot for an urgent review."),
  {
    slug: "break-long-meetings",
    name: "Break after long meetings",
    emoji: "☕",
    group: "buffers",
    summary: "10 min after meetings of 60 min or more.",
    kind: "buffer",
    preset: {
      side: "after",
      minutesAfter: 10,
      filter: { participants: { op: ">=", value: 2 }, length: { op: ">=", minutes: 60 } },
    },
  },
  prompt("adaptive-workday", "Adaptive workday", "Rearrange today's flexible items for new hours."),
  prompt("conflict-fixes", "Conflict fixes", "Fix the conflicts in the dates in view."),
  prompt("plan-my-day", "Plan my day", "Place your top tasks and add short breaks."),
  {
    slug: "peak-energy-focus",
    name: "Peak-energy focus",
    emoji: "⚡",
    group: "focus_time",
    summary: "10 h of focus time each week, from 09:00 to 12:00.",
    kind: "focus_time",
    preset: { weeklyGoalMinutes: 600, window: { days: WORKDAYS, from: "09:00", to: "12:00" } },
  },
  prompt("task-reranking", "Task re-ranking", "Re-rank open tasks by due date and work left."),
  {
    slug: "deep-work",
    name: "Deep work protection",
    emoji: "🎯",
    group: "focus_time",
    summary: "10 h of focus time each week, in blocks of 2 h or more.",
    kind: "focus_time",
    preset: { weeklyGoalMinutes: 600, minBlockMinutes: 120 },
  },
  {
    slug: "meeting-load-cap",
    name: "Meeting load cap",
    group: "other",
    summary: "At most 20 h of meetings a week and 5 h a day.",
    kind: "meeting_overload",
    preset: { dailyMaxHours: 5, weeklyMaxHours: 20 },
  },
  {
    slug: "breaks-meeting-runs",
    name: "Breaks after meeting runs",
    group: "buffers",
    summary: "15 min after back-to-back meetings longer than 90 min.",
    kind: "buffer",
    preset: {
      side: "after",
      minutesAfter: 15,
      level: 3,
      busy: true,
      filter: { participants: { op: ">=", value: 2 }, runLongerThanMinutes: 90 },
    },
  },
  {
    slug: "travel-meetings",
    name: "Travel for external meetings",
    group: "buffers",
    summary: "30 min before and after external meetings at an address.",
    kind: "buffer",
    preset: {
      side: "both",
      minutesBefore: 30,
      minutesAfter: 30,
      filter: { categories: ["external_meeting"], travel: true },
    },
  },
  {
    slug: "focus-before-customers",
    name: "Focus before customer meetings",
    group: "buffers",
    summary: "30 min of solo prep before external meetings. P2.",
    kind: "buffer",
    preset: {
      side: "before",
      minutesBefore: 30,
      level: 2,
      filter: { categories: ["external_meeting"] },
    },
  },
  {
    slug: "sales-prep-debrief",
    name: "Sales call prep and debrief",
    group: "buffers",
    summary: "10 min before and after external meetings.",
    kind: "buffer",
    preset: {
      side: "both",
      minutesBefore: 10,
      minutesAfter: 10,
      filter: { categories: ["external_meeting"] },
    },
  },
  prompt("prep-tasks", "Prep task suggestions", "Suggest prep tasks before next week's meetings."),
  {
    slug: "client-meetings",
    name: "Recurring client meetings",
    group: "flexible_meetings",
    summary: "Every 2 weeks, 30 min. P2.",
    kind: "flexible_meeting",
    preset: { everyWeeks: 2, durationMinutes: 30, level: 2 },
  },
  {
    slug: "no-meeting-day",
    name: "Weekly no-meeting day",
    group: "other",
    summary: "One whole weekday a week without meetings.",
    kind: "no_meeting_day",
    preset: { weekday: 3 },
  },
  {
    slug: "one-on-ones",
    name: "One-on-ones",
    group: "flexible_meetings",
    summary: "Weekly, 30 min, with one other person. P2.",
    kind: "flexible_meeting",
    preset: { everyWeeks: 1, durationMinutes: 30, level: 2 },
  },
  {
    slug: "writing",
    name: "Weekly writing time",
    emoji: "✍️",
    group: "habits",
    summary: "60 min on Monday, Wednesday and Friday. P3.",
    kind: "habit",
    preset: { idealTime: "10:00", minutes: 60, days: [1, 3, 5], level: 3, hours: "work" },
  },
  {
    slug: "reading",
    name: "Weekly reading time",
    emoji: "📚",
    group: "habits",
    summary: "45 min on Tuesday and Thursday. P4.",
    kind: "habit",
    preset: { idealTime: "15:00", minutes: 45, days: [2, 4], level: 4, hours: "work" },
  },
  {
    slug: "priority-link",
    name: "Priority booking link",
    group: "other",
    summary: "30 min at P2, so it offers times over P3 and P4 items.",
    kind: "booking_link",
    preset: { durations: "30", level: 2 },
  },
  {
    slug: "mirror-role-change",
    name: "Mirror calendars after a merger or role change",
    group: "other",
    summary: "Copy busy time between the old and the new work calendar, both ways.",
    kind: "calendar_mirroring",
    preset: { visibility: "busy_only" },
  },
  {
    slug: "mirror-jobs",
    name: "Mirror calendars across several jobs",
    group: "other",
    summary: "Copy busy time from each job calendar into each other one.",
    kind: "calendar_mirroring",
    preset: { visibility: "busy_only" },
  },
  {
    slug: "daily-walk",
    name: "Daily walk",
    emoji: "🚶",
    group: "habits",
    summary: "30 min, Monday to Friday, at 12:30.",
    kind: "habit",
    preset: { idealTime: "12:30", minutes: 30, days: null, level: 3, hours: "work" },
  },
  {
    slug: "exercise",
    name: "Exercise",
    emoji: "🏋️",
    group: "habits",
    summary: "60 min on Monday, Wednesday and Friday, in personal hours.",
    kind: "habit",
    preset: { idealTime: "18:00", minutes: 60, days: [1, 3, 5], level: 3, hours: "personal" },
  },
  {
    slug: "coding",
    name: "Coding time",
    emoji: "💻",
    group: "habits",
    summary: "120 min, Monday to Thursday. P2.",
    kind: "habit",
    preset: { idealTime: "09:00", minutes: 120, days: [1, 2, 3, 4], level: 2, hours: "work" },
  },
  {
    slug: "weekly-planning",
    name: "Weekly planning",
    emoji: "🗓️",
    group: "habits",
    summary: "60 min each Monday at 09:00.",
    kind: "habit",
    preset: { idealTime: "09:00", minutes: 60, days: [1], level: 3, hours: "work" },
  },
  {
    slug: "email",
    name: "Email catch-up",
    emoji: "📧",
    group: "habits",
    summary: "30 min, Monday to Friday, at 16:00. P4.",
    kind: "habit",
    preset: { idealTime: "16:00", minutes: 30, days: null, level: 4, hours: "work" },
  },
  {
    slug: "meditation",
    name: "Meditation",
    emoji: "🧘",
    group: "habits",
    summary: "15 min every day, in personal hours.",
    kind: "habit",
    preset: { idealTime: "18:00", minutes: 15, days: null, level: 3, hours: "personal" },
  },
  {
    slug: "lunch",
    name: "Lunch",
    emoji: "🍱",
    group: "habits",
    summary: "60 min on workdays between 11:30 and 14:00, ideally at 12:00.",
    kind: "habit",
    preset: {
      idealTime: "12:00",
      minutes: 60,
      days: null,
      level: 3,
      hours: "work",
      window: { days: WORKDAYS, from: "11:30", to: "14:00" },
    },
  },
];

export const entry = (slug: string | null) => LIBRARY.find((e) => e.slug === slug);

/** Template from `?template=` in the address bar. */
export const templateFromUrl = () => entry(new URLSearchParams(location.search).get("template"));

/** Rule 9: a second automation from one entry gets a number suffix. */
export function freeName(name: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!used.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}
