// Event settings of an automation (docs/specs/automations-overview.md shared
// fields): how its managed events look on the calendar. Shared by the server
// and the client; no dependencies.

/** The 11 event colors, the calendar's own color, or the category color rule. */
export const ITEM_COLORS = [
  "category",
  "calendar_default",
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
] as const;
export type ItemColor = (typeof ITEM_COLORS)[number];

export const VISIBILITIES = ["calendar_default", "public", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Calendar reminders (planning-notifications.md NTF-14): the calendar default, none, or minutes before. */
export type Reminders = "default" | "none" | number[];

export type SettingsKind = "habit" | "focus_time" | "buffer" | "meeting";

export interface EventSettings {
  /** One emoji before the title, after the state marker (events-title-emoji.md rule 3). */
  emoji: string;
  color: ItemColor;
  visibility: Visibility;
  reminders: Reminders;
  /** Habits: copied to each event. */
  location: string;
  /**
   * Habits, focus time and flexible meetings: the calendar for new events, set
   * at creation only. Null: the main calendar.
   */
  calendarId: string | null;
  /** Focus time: the event description. */
  description: string;
  /** Habits: work or personal; decides the event category and focus counting. */
  category: "work" | "personal";
}

/**
 * The starting values of a new automation. Reminders follow the per-kind table
 * of planning-notifications.md: habits and travel buffers use the calendar
 * default, recovery and other buffers and focus time have none. Focus time and
 * travel buffers are public (focus-time.md, buffers-travel.md outputs).
 */
export function defaultEventSettings(
  kind: SettingsKind,
  opts: { travel?: boolean; personal?: boolean } = {},
): EventSettings {
  const travel = kind === "buffer" && opts.travel === true;
  return {
    emoji: "",
    color: "category",
    visibility: kind === "focus_time" || travel ? "public" : "calendar_default",
    reminders: kind === "habit" || kind === "meeting" || travel ? "default" : "none",
    location: "",
    calendarId: null,
    description: "",
    category: opts.personal ? "personal" : "work",
  };
}

/** Stored JSON on top of the defaults; unknown or broken values fall back. */
export function readEventSettings(
  raw: string | null | undefined,
  base: EventSettings,
): EventSettings {
  let stored: Partial<EventSettings> = {};
  try {
    const v: unknown = JSON.parse(raw || "{}");
    if (v && typeof v === "object") stored = v as Partial<EventSettings>;
  } catch {}
  return { ...base, ...stored };
}
