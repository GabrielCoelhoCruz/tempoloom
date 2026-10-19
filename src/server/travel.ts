// Travel time zones (docs/specs/timezones-home-and-travel.md): entries with
// inclusive local dates. A trip runs from 00:00 of its first date to 24:00 of
// its last date, both in the travel zone. The planning zone of a user is the
// home zone with the trips as legs (src/shared/time.ts travelZone).
import { addDays, localToUtc, travelZone } from "../shared/time.ts";
import { all, type Db, one } from "./db.ts";

export interface TravelEntry {
  id: string;
  tz: string;
  start_date: string;
  end_date: string;
}

export const tripStart = (e: TravelEntry) => localToUtc(e.tz, e.start_date, 0);
export const tripEnd = (e: TravelEntry) => localToUtc(e.tz, addDays(e.end_date, 1), 0);

export function travelEntries(db: Db, userId: string): TravelEntry[] {
  return all<TravelEntry>(
    db,
    "SELECT id, tz, start_date, end_date FROM travel_zones WHERE user_id = ? ORDER BY start_date",
    userId,
  );
}

export function homeZone(db: Db, userId: string): string {
  return (
    one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", userId)?.time_zone ??
    "UTC"
  );
}

/** The zone that wall-clock rules use: the home zone, or a travel zone on its dates. */
export function planningZone(db: Db, userId: string, home = homeZone(db, userId)): string {
  return travelZone(
    home,
    travelEntries(db, userId).map((e) => ({ zone: e.tz, start: tripStart(e), end: tripEnd(e) })),
  );
}

/** The trip that holds `now`, if any. */
export function activeTrip(db: Db, userId: string, now: number): TravelEntry | null {
  return travelEntries(db, userId).find((e) => now >= tripStart(e) && now < tripEnd(e)) ?? null;
}
