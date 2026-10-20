// Times on booking pages: in a chosen zone and a 12- or 24-hour format
// (docs/specs/booking-links-booking-page.md rules 6-8).
import { addLocalDays, utcToLocal } from "../../shared/time.ts";
import { pad } from "./format.ts";

/** How times are written: the selected zone and the 12- or 24-hour format (rules 6-8). */
export interface View {
  zone: string;
  format: "12" | "24";
}

export const FORMAT_KEY = "tl-time-format";
export function savedFormat(): "12" | "24" {
  const saved = localStorage.getItem(FORMAT_KEY);
  if (saved === "12" || saved === "24") return saved;
  // Proposed default: the browser locale's clock.
  const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12" ? "12" : "24";
}

export function timeText(v: View, t: number): string {
  const m = utcToLocal(v.zone, t).minuteOfDay;
  const h = Math.floor(m / 60);
  if (v.format === "24") return `${pad(h)}:${pad(m % 60)}`;
  return `${h % 12 || 12}:${pad(m % 60)} ${h < 12 ? "AM" : "PM"}`;
}
export const dayText = (v: View, t: number) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: v.zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(t);
export const dayOf = (v: View, t: number) => utcToLocal(v.zone, t).date;

/**
 * Times show two weeks per page: a page ends 14 local days after its start, at
 * the same wall-clock time in the selected zone, also across a DST change.
 */
export const addPages = (v: View, t: number, pages: number) => addLocalDays(t, 14 * pages, v.zone);
