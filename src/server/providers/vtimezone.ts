// A VTIMEZONE for an IANA zone (RFC 5545 3.6.5), so a recurring series keeps
// its local time across daylight-saving changes on every calendar server.
import {
  addDays,
  DAY,
  HOUR,
  MINUTE,
  utcToLocal,
  weekdayOf,
  zoneOffset,
} from "../../shared/time.ts";

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const pad = (n: number) => String(n).padStart(2, "0");

const offsetText = (ms: number) => {
  const m = Math.round(Math.abs(ms) / MINUTE);
  return `${ms < 0 ? "-" : "+"}${pad(Math.floor(m / 60))}${pad(m % 60)}`;
};

/** The instants in `year` (UTC) where the zone's offset changes, found to the quarter hour. */
function transitions(zone: string, year: number): number[] {
  const out: number[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let t = Date.UTC(year, 0, 1); t < end; t += DAY) {
    if (zoneOffset(zone, t) === zoneOffset(zone, t + DAY)) continue;
    let lo = t;
    let hi = t + DAY;
    while (hi - lo > 15 * MINUTE) {
      const mid = lo + Math.floor((hi - lo) / (30 * MINUTE)) * 15 * MINUTE;
      if (zoneOffset(zone, mid) === zoneOffset(zone, lo)) lo = mid;
      else hi = mid;
    }
    out.push(hi);
  }
  return out;
}

/** The VTIMEZONE text of `zone`, with yearly rules from its changes in `year`. */
export function vtimezone(zone: string, year: number): string {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
  const changes = transitions(zone, year);
  if (changes.length === 0) {
    const o = offsetText(zoneOffset(zone, Date.UTC(year, 0, 1)));
    lines.push(
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${o}`,
      `TZOFFSETTO:${o}`,
      "END:STANDARD",
    );
  }
  for (const t of changes) {
    const from = zoneOffset(zone, t - HOUR);
    const to = zoneOffset(zone, t);
    // The change as the old local time shows it: Sunday 02:00 for 02:00 -> 03:00.
    const at = utcToLocal("UTC", t + from);
    const [y, mo, d] = at.date.split("-").map(Number) as [number, number, number];
    const last = addDays(at.date, 7).slice(5, 7) !== at.date.slice(5, 7);
    const nth = last ? -1 : Math.ceil(d / 7);
    const kind = to > from ? "DAYLIGHT" : "STANDARD";
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${y}${pad(mo)}${pad(d)}T${pad(Math.floor(at.minuteOfDay / 60))}${pad(at.minuteOfDay % 60)}00`,
      `RRULE:FREQ=YEARLY;BYMONTH=${mo};BYDAY=${nth}${BYDAY[weekdayOf(at.date) - 1]}`,
      `TZOFFSETFROM:${offsetText(from)}`,
      `TZOFFSETTO:${offsetText(to)}`,
      `END:${kind}`,
    );
  }
  lines.push("END:VTIMEZONE");
  return lines.join("\r\n");
}
