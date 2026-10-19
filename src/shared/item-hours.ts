// Item-specific hours as forms show them (docs/specs/planning-hours.md): one
// range on some weekdays. Stored hours may hold more (several ranges, or other
// ranges on other days); a form that shows only one range must not save it
// over them unless the user changes the range.

/** Minutes of the day per ISO weekday ("1" is Monday). */
export type Weekly = Record<string, [number, number][]>;

/** One range on the given ISO weekdays; times are "HH:MM". */
export interface ItemRange {
  days: number[];
  from: string;
  to: string;
}

const minuteOf = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

/** The range as hours; "00:00" as the end means midnight. */
export function itemHoursOf(r: ItemRange): Weekly {
  const range: [number, number] = [minuteOf(r.from), minuteOf(r.to) || 1440];
  return Object.fromEntries(r.days.map((d) => [String(d), [range]]));
}

/** The form's view of stored hours: their days and the first range. */
export function itemRangeOf(weekly: Weekly): ItemRange {
  const days = Object.keys(weekly)
    .filter((d) => (weekly[d]?.length ?? 0) > 0)
    .map(Number)
    .sort((a, b) => a - b);
  const [s, e] = weekly[String(days[0])]?.[0] ?? [540, 1020];
  return { days, from: timeOf(s), to: timeOf(e) };
}

export function sameHours(a: Weekly, b: Weekly): boolean {
  const days = (w: Weekly) => Object.keys(w).filter((d) => (w[d]?.length ?? 0) > 0);
  const da = days(a);
  return (
    da.length === days(b).length &&
    da.every((d) => JSON.stringify(a[d]) === JSON.stringify(b[d] ?? []))
  );
}

/** True when one range on its days shows the stored hours in full. */
export const fitsOneRange = (weekly: Weekly): boolean =>
  sameHours(itemHoursOf(itemRangeOf(weekly)), weekly);

/**
 * The hours a form saves: none (keep the stored ones) when the user left the
 * shown range as it was, else the form's range.
 */
export function changedHours(stored: Weekly | null, fromForm: Weekly): Weekly | undefined {
  if (stored && sameHours(fromForm, itemHoursOf(itemRangeOf(stored)))) return undefined;
  return fromForm;
}
