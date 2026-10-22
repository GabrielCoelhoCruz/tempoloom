// Types, texts and the attention list of the Meetings page (meetings-flexible.md,
// meetings-flexible-rescheduling.md), apart so that meetings.tsx stays short.
import type { EventSettings } from "../../shared/event-settings.ts";
import type { Weekly } from "../../shared/item-hours.ts";
import { dateText, dateTimeText } from "../lib/format.ts";
import { DAY_NAMES, type Missed, type Person } from "./meetings-availability.tsx";

export interface Meeting extends Missed {
  id: string;
  /** The email of the disconnected account that holds the meeting's calendar. */
  disconnected: string | null;
  title: string;
  level: number;
  enabled: number;
  ideal_minute: number;
  duration_minutes: number;
  shortest_minutes: number;
  hours_mode: string;
  starting: string | null;
  description: string;
  location: string;
  when_unplaceable: string;
  lead_minutes: number;
  auto_reschedule: string;
  auto_lock: string | null;
  defense: string;
  frequency: Frequency;
  item_hours: string | null;
  event_settings: EventSettings;
  attendees: (Person & { required: boolean; hoursOverride: Weekly | null })[];
  occurrences: { id: string; key: string; start_ms: number; end_ms: number; locked: number }[];
  problems: {
    demandKey: string;
    status: string;
    reason: string;
    suggestions?: { start: number; end: number }[];
    /** The period of the problem: its first day, a day or a week long. */
    period: { start: string; kind: "day" | "week" };
  }[];
  changes: Change[];
  series_event_id: string | null;
  /** 1: Tempoloom writes the series (a meeting from the form); 0: an adopted series. */
  series_owned: number;
}

/** Rules attached to the user's own recurring meeting (rule 1), not a series Tempoloom wrote. */
export const adopted = (m: Meeting) => m.series_event_id !== null && !m.series_owned;

export type Frequency =
  | { period: "daily"; everyDays?: number }
  | { period: "weekly"; everyWeeks: number; idealDays: number[] }
  | ({ period: "monthly"; everyMonths?: number } & (
      | { dayOfMonth: number }
      | { nth: number | "last"; weekday: number }
    ));

export const NTH: Record<string, string> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
  last: "last",
};
export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** "every 2 weeks, ideally Tue", "every month, ideally on day 15". */
export function describeFrequency(f: Frequency): string {
  const every = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  if (f.period === "daily") return every(f.everyDays ?? 1, "day");
  if (f.period === "monthly")
    return `${every(f.everyMonths ?? 1, "month")}, ideally on ${
      "nth" in f ? `the ${NTH[f.nth]} ${WEEKDAYS[f.weekday - 1]}` : `day ${f.dayOfMonth}`
    }`;
  return `${every(f.everyWeeks, "week")}, ideally ${f.idealDays.map((d) => DAY_NAMES[d - 1]).join(", ")}`;
}

export const EVERY: [string, string][] = [
  ["1", "Every week"],
  ["2", "Every 2 weeks"],
  ["4", "Every 4 weeks"],
  ["daily", "Every day"],
  ["monthly", "Every month"],
  ["custom", "Custom"],
];

/** The "How often" choice that shows a frequency, with the custom count and unit. */
export function everyOf(f: Frequency): { every: string; unit: string; n: number } {
  if (f.period === "daily") {
    const n = f.everyDays ?? 1;
    return n === 1 ? { every: "daily", unit: "days", n } : { every: "custom", unit: "days", n };
  }
  if (f.period === "monthly") {
    const n = f.everyMonths ?? 1;
    return n === 1
      ? { every: "monthly", unit: "months", n }
      : { every: "custom", unit: "months", n };
  }
  const n = f.everyWeeks;
  return [1, 2, 4].includes(n)
    ? { every: String(n), unit: "weeks", n }
    : { every: "custom", unit: "weeks", n };
}

/** An adopted series repeats daily or every N weeks on its day (rule 1). */
export const seedFrequency = (x: Series): Frequency =>
  x.everyWeeks === "daily"
    ? { period: "daily" }
    : { period: "weekly", everyWeeks: x.everyWeeks, idealDays: [x.idealDay] };

export const VISIBILITY: Record<string, string> = {
  calendar_default: "calendar default visibility",
  public: "public",
  private: "private",
};

export interface Change {
  id: number;
  occurrence_key: string;
  old_start: number | null;
  new_start: number | null;
  actor: string;
  reason: string;
  detail: string;
}

export interface Series {
  key: string;
  calendarId: string;
  seriesId: string;
  title: string;
  description: string;
  location: string;
  attendees: string[];
  start: number;
  end: number;
  idealTime: string;
  idealDay: number;
  everyWeeks: number | "daily";
}

/** MEET-02 rules 9-11: flags that offer other times. */
export const FLAGS: Record<string, string> = {
  "budget-reached": "Move limit reached: Tempoloom used today's automatic moves.",
  "policy-none": "No automatic moves: this meeting has a conflict at its time.",
  "locked-conflict": "Locked: this occurrence has a conflict at its time and does not move.",
};
export const CHANGE_REASONS: Record<string, string> = {
  conflict: "moved for a conflict",
  declined: "declined",
  ruleChanged: "rules changed",
  noFreeSlot: "cancelled, no free time",
  manualMove: "moved by hand",
  manualSkip: "skipped",
  seriesDeleted: "series deleted in the calendar; turned off",
};
/** MEET-02 rule 14: "" follows the setting for flexible meetings (Settings, Auto-lock). */
export const AUTO_LOCK: [string, string][] = [
  ["", "As in settings"],
  ["off", "Off"],
  ["day", "Each day"],
  ["week", "Each week"],
];
export const MOVES: [string, string][] = [
  ["none", "No automatic moves"],
  ["conservative", "1 per day"],
  ["moderate", "3 per day"],
  ["aggressive", "5 per day"],
];
export interface Preview {
  occurrences: { start: number; end: number; conflict: boolean }[];
  problems: { demandKey: string; status: string; reason: string }[];
  moved: number;
  /** Accounts rule 16: the disconnected account that the meeting waits for. */
  waiting: string | null;
}

export const DEFENSE: Record<string, string> = {
  adaptive: "Free until time gets short",
  busy: "Always busy",
  free: "Always free",
};
export const AWAY = "time away (all-day or out-of-office events) fills the period";
export const REASONS: Record<string, string> = {
  "no-hours-overlap": "no time inside everyone's meeting hours",
  "no-space-fixed": "no free time in the period",
  away: AWAY,
  // Reports stored before the rename still say "all-day-block".
  "all-day-block": AWAY,
  "no-space-priority": "higher-priority items take all free time",
  "no-hours": "no meeting hours in the period",
  "outside-window": "outside the planning window",
  "too-long-for-hours": "longer than any range of the meeting hours",
};

/** MEET-02 rule 33: every unplaced or conflicting occurrence of all meetings, with its reason. */
export function Attention({ meetings, zone: z }: { meetings: Meeting[]; zone: string }) {
  const items = meetings.flatMap((m) =>
    m.problems.map((p) => ({
      m,
      p,
      occurrence: m.occurrences.find((o) => o.key === p.demandKey),
    })),
  );
  if (items.length === 0) return null;
  return (
    <section data-testid="meeting-attention">
      <h2>Needs your attention</h2>
      <ul class="list">
        {items.map(({ m, p, occurrence }) => (
          <li
            class="row warning"
            key={`${m.id}-${p.demandKey}`}
            data-testid="attention-item"
            data-reason={p.reason}
          >
            {m.title} ·{" "}
            {occurrence
              ? dateTimeText(z, occurrence.start_ms)
              : `${p.period.kind === "day" ? "day" : "week of"} ${dateText(p.period.start)}`}{" "}
            · {p.status === "conflict" ? "Conflict" : "Not placed"}:{" "}
            {FLAGS[p.reason] ?? REASONS[p.reason] ?? p.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}
