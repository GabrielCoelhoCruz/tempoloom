// Wall-clock helpers. Instants are epoch milliseconds (UTC). A local date is a
// "YYYY-MM-DD" string. A local time is a minute of the day (0..1440).

export type LocalDate = string;
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new RangeError(`Unknown time zone: ${zone}`);
    }
    formatters.set(zone, f);
  }
  return f;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in a zone, as a fake UTC timestamp. */
function wallClockAsUtc(zone: string, epochMs: number): number {
  const parts = formatterFor(zone).formatToParts(epochMs);
  const n = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
}

/** Zone offset from UTC at an instant, in milliseconds. */
export function zoneOffset(zone: string, epochMs: number): number {
  const floored = Math.floor(epochMs / 1000) * 1000;
  return wallClockAsUtc(zone, floored) - floored;
}

function parseDate(date: LocalDate): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  return [y, mo, d];
}

/**
 * Instant of a local wall-clock time. A time inside a DST gap moves forward
 * by the gap length; a time inside an overlap resolves to the earlier instant.
 */
export function localToUtc(zone: string, date: LocalDate, minuteOfDay: number): number {
  const [y, mo, d] = parseDate(date);
  const wall = Date.UTC(y, mo - 1, d) + minuteOfDay * MINUTE;
  const before = zoneOffset(zone, wall - DAY);
  const after = zoneOffset(zone, wall + DAY);
  let best: number | undefined;
  for (const offset of before === after ? [before] : [before, after]) {
    const t = wall - offset;
    if (t + zoneOffset(zone, t) === wall && (best === undefined || t < best)) best = t;
  }
  return best ?? wall - before;
}

export interface LocalTime {
  date: LocalDate;
  minuteOfDay: number;
  weekday: IsoWeekday;
}

export function utcToLocal(zone: string, epochMs: number): LocalTime {
  const wall = wallClockAsUtc(zone, epochMs);
  const dayStart = Math.floor(wall / DAY) * DAY;
  const date = new Date(dayStart).toISOString().slice(0, 10);
  return { date, minuteOfDay: Math.floor((wall - dayStart) / MINUTE), weekday: weekdayOf(date) };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, mo, d] = parseDate(date);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOf(date: LocalDate): IsoWeekday {
  const [y, mo, d] = parseDate(date);
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return (js === 0 ? 7 : js) as IsoWeekday;
}

export function diffDays(from: LocalDate, to: LocalDate): number {
  const [y1, m1, d1] = parseDate(from);
  const [y2, m2, d2] = parseDate(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY);
}
