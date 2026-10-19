// A habit's frequency as text and as read from the habit forms (habits-automation.md "Frequency").
import type { HabitFrequency } from "../../scheduler/model.ts";

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export const ORDINALS: Record<string, string> = {
  "1": "1st",
  "2": "2nd",
  "3": "3rd",
  "4": "4th",
  "5": "5th",
  last: "last",
};
export const MAX_INTERVAL = 52;

/** "daily", "Tue, Thu", "monthly on day 15", "every 2 weeks on Tue" or "every 3 months, on the 2nd Friday". */
export function frequencyText(f: HabitFrequency): string {
  const n = f.interval ?? 1;
  if (f.period === "daily") return n > 1 ? `every ${n} days` : "daily";
  if (f.period === "weekly") {
    const days = f.days.map((d) => DAY_NAMES[d - 1]).join(", ");
    return n > 1 ? `every ${n} weeks on ${days}` : days;
  }
  const on =
    "dayOfMonth" in f
      ? `on day ${f.dayOfMonth}`
      : `on the ${ORDINALS[String(f.nth)]} ${WEEKDAYS[f.weekday - 1]}`;
  return n > 1 ? `every ${n} months, ${on}` : `monthly ${on}`;
}

/** The frequency a habit form holds: monthly fields first, then the chosen days, then the interval. */
export function readFrequency(f: FormData): HabitFrequency {
  const repeat = String(f.get("repeat") ?? "");
  const days = f.getAll("days").map(Number);
  const nth = String(f.get("nth"));
  const base: HabitFrequency =
    repeat === "day"
      ? { period: "monthly", dayOfMonth: Number(f.get("dayOfMonth")) }
      : repeat === "nth"
        ? {
            period: "monthly",
            nth: nth === "last" ? "last" : (Number(nth) as 1 | 2 | 3 | 4 | 5),
            weekday: Number(f.get("weekday")),
          }
        : days.length
          ? { period: "weekly", days }
          : { period: "daily" };
  const interval = Math.min(MAX_INTERVAL, Math.max(1, Math.round(Number(f.get("interval")) || 1)));
  return interval > 1 ? { ...base, interval } : base;
}
