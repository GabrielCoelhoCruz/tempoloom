// Times and dates as the user reads them (docs/specs/settings-profile.md PRF-6):
// the time format (12 or 24 hours), the date format and the week start of the
// calendar account. Values for form inputs (hhmm, toLocalInput) stay in the
// fixed format the inputs need.
import {
  DEFAULT_FORMATS,
  type Formats,
  formatsOf,
  dateText as sharedDate,
  timeText as sharedTime,
  weekdayText,
} from "../../shared/formats.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { me } from "./state.ts";

export const pad = (n: number) => String(n).padStart(2, "0");

/** "14:30" for <input type="time"> values; use timeText for text. */
export function hhmm(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

export function parseHhmm(v: string): number {
  const [h, m] = v.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** "2026-11-09T14:30" in the user's zone, for <input type="datetime-local">. */
export function toLocalInput(zone: string, t: number): string {
  const l = utcToLocal(zone, t);
  return `${l.date}T${hhmm(l.minuteOfDay)}`;
}

export function fromLocalInput(zone: string, v: string): number {
  const [date, time] = v.split("T") as [LocalDate, string];
  return localToUtc(zone, date, parseHhmm(time));
}

export type { Formats };

/** The signed-in user's formats (src/shared/formats.ts formatsOf). */
export function userFormats(): Formats {
  const s = me.value?.settings;
  return s ? formatsOf(s) : DEFAULT_FORMATS;
}

/** A minute of the day: "14:30" or "2:30 PM"; 1440 is the end of the day. */
export const timeText = (minute: number, f: Formats = userFormats()) => sharedTime(minute, f);

/** An hour label of the planner grid: "14:00" or "2 PM". */
export function hourText(hour: number, f: Formats = userFormats()): string {
  if (f.time === "24h") return `${pad(hour)}:00`;
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** A date: "2026-11-09", "09/11/2026" or "11/09/2026". */
export const dateText = (date: LocalDate, f: Formats = userFormats()) => sharedDate(date, f);

export { weekdayText };

/** The ISO weekdays (1 Monday to 7 Sunday) in display order. */
export function weekdaysInOrder(f: Formats = userFormats()): number[] {
  return Array.from({ length: 7 }, (_, i) => ((f.weekStart - 1 + i) % 7) + 1);
}

/** The first day of the display week that holds `date`. */
export function displayWeekOf(date: LocalDate, f: Formats = userFormats()): LocalDate {
  return addDays(date, -((weekdayOf(date) - f.weekStart + 7) % 7));
}

/** A time in a zone: "Mon 2026-11-09 14:30", in the user's formats. */
export function formatWhen(zone: string, t: number, f: Formats = userFormats()): string {
  const l = utcToLocal(zone, t);
  return `${weekdayText(l.date)} ${dateText(l.date, f)} ${timeText(l.minuteOfDay, f)}`;
}

/** A time in a zone without the weekday: "2026-11-09 14:30", in the user's formats. */
export function dateTimeText(zone: string, t: number, f: Formats = userFormats()): string {
  const l = utcToLocal(zone, t);
  return `${dateText(l.date, f)} ${timeText(l.minuteOfDay, f)}`;
}

/** The time of day of `t` in a zone, in the user's time format. */
export function clockText(zone: string, t: number, f: Formats = userFormats()): string {
  return timeText(utcToLocal(zone, t).minuteOfDay, f);
}

/** A time of day with seconds: "14:30:05" or "2:30:05 PM". */
export function clockSecondsText(zone: string, t: number, f: Formats = userFormats()): string {
  const [hm, ampm] = clockText(zone, t, f).split(" ");
  const s = pad(Math.floor((((t % 60_000) + 60_000) % 60_000) / 1000));
  return ampm ? `${hm}:${s} ${ampm}` : `${hm}:${s}`;
}

export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}
