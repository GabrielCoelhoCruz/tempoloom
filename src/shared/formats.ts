// Times and dates as the user reads them (docs/specs/settings-profile.md PRF-6):
// the time format (12 or 24 hours), the date format and the week start of the
// calendar account. The pages (src/web/lib/format.ts) and the server texts the
// user reads (change log, help page, preview) share these rules.
import type { Settings } from "../server/settings.ts";
import { type LocalDate, weekdayOf } from "./time.ts";

export interface Formats {
  time: Settings["timeFormat"];
  date: Settings["dateFormat"];
  /** The first day of the week in displays: 1 Monday, 7 Sunday. */
  weekStart: 1 | 7;
}

export const DEFAULT_FORMATS: Formats = { time: "24h", date: "YMD", weekStart: 1 };

/**
 * The formats of a user's settings. The week start of displays is the calendar
 * account's (googleWeekStart), else the planning week start; planning itself
 * uses only the planning week start (settings-profile.md, "Which week each
 * feature uses").
 */
export function formatsOf(
  s: Pick<Settings, "timeFormat" | "dateFormat" | "weekStart" | "googleWeekStart">,
): Formats {
  return { time: s.timeFormat, date: s.dateFormat, weekStart: s.googleWeekStart ?? s.weekStart };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A minute of the day: "14:30" or "2:30 PM"; 1440 is the end of the day. */
export function timeText(minute: number, f: Formats): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  if (f.time === "24h") return minute === 1440 ? "24:00" : `${pad(h)}:${pad(m)}`;
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** A date: "2026-11-09", "09/11/2026" or "11/09/2026". */
export function dateText(date: LocalDate, f: Formats): string {
  const [y, m, d] = date.split("-") as [string, string, string];
  if (f.date === "DMY") return `${d}/${m}/${y}`;
  if (f.date === "MDY") return `${m}/${d}/${y}`;
  return date;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** "Mon" to "Sun". */
export const weekdayText = (date: LocalDate) => WEEKDAYS[weekdayOf(date) - 1] as string;
