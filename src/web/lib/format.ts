import { type LocalDate, localToUtc, utcToLocal } from "../../shared/time.ts";

export const pad = (n: number) => String(n).padStart(2, "0");

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

export function formatWhen(zone: string, t: number): string {
  return new Date(t).toLocaleString(undefined, {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}
