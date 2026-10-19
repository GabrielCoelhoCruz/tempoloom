// Calendar facts (docs/specs/analytics-weekly-reports.md rule 7): one wording
// for the stats page and the weekly report email.

export type Fact =
  | { kind: "busiest_day"; day: string; minutes: number }
  | { kind: "longest_focus"; minutes: number }
  | { kind: "booked_meetings"; count: number }
  | { kind: "breaks"; minutes: number }
  | { kind: "people_met"; count: number };

/** Whole minutes as "2 h 30 min", "2 h" or "30 min". */
export function hoursText(minutes: number): string {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
}

export function factText(f: Fact): string {
  switch (f.kind) {
    case "busiest_day":
      return `Busiest meeting day: ${f.day} (${hoursText(f.minutes)})`;
    case "longest_focus":
      return `Longest focus session: ${hoursText(f.minutes)}`;
    case "booked_meetings":
      return `Meetings booked through links: ${f.count}`;
    case "breaks":
      return `Breaks taken: ${hoursText(f.minutes)}`;
    case "people_met":
      return `People met: ${f.count}`;
    default: {
      const never: never = f;
      return never;
    }
  }
}
