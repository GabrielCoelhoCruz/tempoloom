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

// Offsets change only at transitions, and every transition since 1970 falls on
// a quarter hour, so one Intl lookup per zone and 15-minute bucket is enough.
const OFFSET_BUCKET = 15 * MINUTE;
const CACHE_LIMIT = 200_000;
const offsets = new Map<string, Map<number, number>>();

// A travel zone (timezones-home-and-travel.md) is a composite zone: the home
// zone plus legs "Zone@start-end" (epoch ms, end exclusive), joined by "|".
// Every wall-clock rule then follows the zone of the leg that holds the
// instant, the way it follows a daylight-saving change. Legs start and end on
// quarter hours, like every real transition.
interface Leg {
  zone: string;
  start: number;
  end: number;
}
const composites = new Map<string, { home: string; legs: Leg[]; zones: string[] }>();

function compositeOf(zone: string) {
  let c = composites.get(zone);
  if (!c) {
    const [home = "UTC", ...rest] = zone.split("|");
    const legs = rest.map((part) => {
      const at = part.lastIndexOf("@");
      const [start, end] = part
        .slice(at + 1)
        .split("-")
        .map(Number) as [number, number];
      return { zone: part.slice(0, at), start, end };
    });
    c = { home, legs, zones: [...new Set([home, ...legs.map((l) => l.zone)])] };
    if (composites.size >= 1000) composites.clear();
    composites.set(zone, c);
  }
  return c;
}

/** A composite zone: `home` with travel legs on instant ranges. */
export function travelZone(home: string, legs: readonly Leg[]): string {
  return legs.length === 0
    ? home
    : [home, ...legs.map((l) => `${l.zone}@${l.start}-${l.end}`)].join("|");
}

/** The real zone that a (possibly composite) zone uses at an instant. */
export function zoneAt(zone: string, epochMs: number): string {
  if (!zone.includes("|")) return zone;
  const c = compositeOf(zone);
  return c.legs.find((l) => epochMs >= l.start && epochMs < l.end)?.zone ?? c.home;
}

/** Zone offset from UTC at an instant, in milliseconds. */
export function zoneOffset(zone: string, epochMs: number): number {
  const bucket = Math.floor(epochMs / OFFSET_BUCKET);
  let byBucket = offsets.get(zone);
  if (!byBucket) {
    byBucket = new Map();
    offsets.set(zone, byBucket);
  }
  let offset = byBucket.get(bucket);
  if (offset === undefined) {
    const at = bucket * OFFSET_BUCKET;
    offset = wallClockAsUtc(zoneAt(zone, at), at) - at;
    if (byBucket.size >= CACHE_LIMIT) byBucket.clear();
    byBucket.set(bucket, offset);
  }
  return offset;
}

const parsedDates = new Map<string, [number, number, number]>();

function parseDate(date: LocalDate): [number, number, number] {
  const cached = parsedDates.get(date);
  if (cached) return cached;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  if (parsedDates.size >= CACHE_LIMIT) parsedDates.clear();
  const parts: [number, number, number] = [y, mo, d];
  parsedDates.set(date, parts);
  return parts;
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
  // A composite zone can change twice within two days (a one-day trip): try
  // the offsets of all its zones.
  const candidates = zone.includes("|")
    ? compositeOf(zone).zones.flatMap((z) => [zoneOffset(z, wall - DAY), zoneOffset(z, wall + DAY)])
    : before === after
      ? [before]
      : [before, after];
  let best: number | undefined;
  for (const offset of candidates) {
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
  const wall = epochMs + zoneOffset(zone, epochMs);
  const dayStart = Math.floor(wall / DAY) * DAY;
  const date = new Date(dayStart).toISOString().slice(0, 10);
  return { date, minuteOfDay: Math.floor((wall - dayStart) / MINUTE), weekday: weekdayOf(date) };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, mo, d] = parseDate(date);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The same local wall-clock time `days` calendar days later in `zone` (not
 * days x 24 hours), with the seconds kept. A target time inside a DST gap moves
 * forward by the gap. From the second pass of a repeated hour, the result keeps
 * the second pass when the target day repeats that hour too.
 */
export function addLocalDays(epochMs: number, days: number, zone: string): number {
  const l = utcToLocal(zone, epochMs);
  const date = addDays(l.date, days);
  const seconds = ((epochMs % MINUTE) + MINUTE) % MINUTE;
  const first = localToUtc(zone, date, l.minuteOfDay) + seconds;
  const pass = epochMs - seconds - localToUtc(zone, l.date, l.minuteOfDay);
  if (pass === 0) return first;
  const back = utcToLocal(zone, first + pass);
  return back.date === date && back.minuteOfDay === l.minuteOfDay ? first + pass : first;
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
