// Group figures from members' days: team stats as means over members
// (docs/specs/analytics-team-stats.md rules 1-6) and organization metrics
// (analytics-organization.md rules 2-7). No function here returns one
// member's value; callers apply the privacy guard of 3 people.
import { BUCKETS, type Bucket, type Day } from "./member.ts";

/** A workday with this many meeting minutes or more is heavy (deep work score, b). */
const HEAVY_DAY = 240;
/** Working hours per year for the hourly cost (tools-meeting-cost-calculator.md). */
export const HOURS_PER_YEAR = 1920;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
export const meetingMinutes = (d: Day) =>
  d.minutes.oneOnOne + d.minutes.teamMeetings + d.minutes.externalMeetings;
const workdays = (days: Day[]) => days.filter((d) => d.work > 0).length;
/** A member's minutes per week of the range. */
const weekly = (days: Day[], f: (d: Day) => number) =>
  (sum(days.map(f)) * 7) / Math.max(1, days.length);
/** A member's minutes per workday of the range. */
const perWorkday = (days: Day[], f: (d: Day) => number) => {
  const n = workdays(days);
  return n ? sum(days.map(f)) / n : 0;
};

/**
 * Deep work score (organization rule 3, proposed formula) over the pooled
 * days of a group: 25 × (a + b + c + d), rounded. Null without work hours.
 */
export function deepWorkScore(people: Day[][]): number | null {
  const days = people.flat();
  const work = sum(days.map((d) => d.work));
  const workDays = days.filter((d) => d.work > 0);
  if (!work || !workDays.length) return null;
  const a = 1 - sum(days.map((d) => meetingMinutes(d) - d.meetingsOutsideWork)) / work;
  const b = workDays.filter((d) => meetingMinutes(d) < HEAVY_DAY).length / workDays.length;
  const free = sum(days.map((d) => d.minutes.free));
  // Without free work time, there is no long block and nothing usable.
  const c = free ? sum(days.map((d) => d.freeInLongBlocks)) / free : 0;
  const dd = free ? 1 - sum(days.map((d) => d.fragmented)) / free : 0;
  return Math.round(25 * (a + b + c + dd));
}

export const THRESHOLDS = { week: [0, 5, 10, 15, 20, 25, 30], day: [0, 1, 2, 3, 4, 5, 6] };

/**
 * Team stats rule 5: the percent of members whose meeting hours reach each
 * threshold, per week of the range or per workday.
 */
export function distribution(people: Day[][], unit: "week" | "day") {
  const hours = people.map(
    (days) =>
      (unit === "week" ? weekly(days, meetingMinutes) : perWorkday(days, meetingMinutes)) / 60,
  );
  const thresholds = THRESHOLDS[unit];
  return {
    unit,
    thresholds,
    percent: thresholds.map((t) =>
      Math.round((100 * hours.filter((h) => h >= t - 1e-9).length) / Math.max(1, hours.length)),
    ),
  };
}

export interface Metrics {
  /** Minutes per person per week. */
  meetings: number;
  oneOnOne: number;
  teamMeetings: number;
  externalMeetings: number;
  /** Meeting minutes per person per workday. */
  dailyMeetingLoad: number;
  /** Solo work minutes per person per week, and the deep part of it. */
  focus: number;
  deepWork: number;
  /** Mean length in minutes of the group's solo sessions; null without sessions. */
  focusSession: number | null;
  /** Fragmented minutes per person per workday. */
  fragmented: number;
  free: number;
  travel: number;
  breaks: number;
  score: number | null;
  /** Meeting hours × each person's hourly cost, summed over the group. */
  cost: number;
}

/** Organization metrics of one group for one period. */
export function groupMetrics(people: { days: Day[]; hourly: number }[]): Metrics {
  const w = (f: (d: Day) => number) => mean(people.map((p) => weekly(p.days, f)));
  const bucket = (b: Bucket) => w((d) => d.minutes[b]);
  const sessions = people.flatMap((p) => p.days.flatMap((d) => d.sessions));
  return {
    meetings: w(meetingMinutes),
    oneOnOne: bucket("oneOnOne"),
    teamMeetings: bucket("teamMeetings"),
    externalMeetings: bucket("externalMeetings"),
    dailyMeetingLoad: mean(people.map((p) => perWorkday(p.days, meetingMinutes))),
    focus: w((d) => d.minutes.deepWork + d.minutes.shallowWork),
    deepWork: bucket("deepWork"),
    focusSession: sessions.length ? sum(sessions) / sessions.length : null,
    fragmented: mean(people.map((p) => perWorkday(p.days, (d) => d.fragmented))),
    free: bucket("free"),
    travel: bucket("travel"),
    breaks: bucket("breaks"),
    score: deepWorkScore(people.map((p) => p.days)),
    cost: sum(people.map((p) => (sum(p.days.map(meetingMinutes)) / 60) * p.hourly)),
  };
}

/** Index ranges of the periods of a range: one per day, or 7-day chunks from the start. */
export function periods(length: number, grouping: "day" | "week"): [number, number][] {
  const size = grouping === "day" ? 1 : 7;
  const out: [number, number][] = [];
  for (let i = 0; i < length; i += size) out.push([i, Math.min(length, i + size)]);
  return out;
}

const EXTRA = ["meetings", "outsideWork", "tasks", "workHabits", "focusHeld", "bookings"] as const;
type Figure = Bucket | (typeof EXTRA)[number];
const figure = (d: Day, f: Figure): number =>
  f === "meetings"
    ? meetingMinutes(d)
    : f === "outsideWork"
      ? d.meetingsOutsideWork
      : f === "tasks" || f === "workHabits" || f === "focusHeld" || f === "bookings"
        ? d[f]
        : d.minutes[f];

/** Team stats: each figure is the mean over members of that member's figure (rule 1). */
export function teamStats(people: Day[][], grouping: "day" | "week") {
  const first = people[0] ?? [];
  const chunks = periods(first.length, grouping);
  const figures = [...BUCKETS, ...EXTRA] as Figure[];
  const avg = (f: (days: Day[]) => number) => mean(people.map(f));
  const averages = Object.fromEntries(
    figures.map((f) => [f, avg((days) => sum(days.map((d) => figure(d, f))) / chunks.length)]),
  ) as Record<Figure, number>;
  const trend = chunks.map(([a, b]) => ({
    start: first[a]?.date ?? "",
    end: first[b - 1]?.date ?? "",
    minutes: Object.fromEntries(
      BUCKETS.map((f) => [f, avg((days) => sum(days.slice(a, b).map((d) => d.minutes[f])))]),
    ) as Record<Bucket, number>,
  }));
  // Weekday figures: each member's mean per occurrence of the weekday, then the mean over members.
  const byWeekday = (f: (d: Day) => number) =>
    [1, 2, 3, 4, 5, 6, 7].map((wd) =>
      avg((days) => mean(days.filter((d) => d.weekday === wd).map(f))),
    );
  const meetings = byWeekday(meetingMinutes);
  const work = byWeekday((d) => d.work);
  const solo = byWeekday((d) => d.minutes.deepWork + d.minutes.shallowWork);
  const workWeekdays = [1, 2, 3, 4, 5, 6, 7].filter((wd) => (work[wd - 1] ?? 0) > 0);
  const pick = (values: number[], better: (a: number, b: number) => boolean) => {
    let best: number | null = null;
    for (const wd of workWeekdays) {
      const v = values[wd - 1] ?? 0;
      if (best === null || better(v, values[best - 1] ?? 0)) best = wd;
    }
    return best;
  };
  const heaviest = Math.max(0, ...meetings) > 0 ? pick(meetings, (a, b) => a > b) : null;
  return {
    grouping,
    averages,
    trend,
    meetingDays: { heaviest, lightest: heaviest ? pick(meetings, (a, b) => a < b) : null },
    focusDays: {
      minutes: solo,
      mostProductive: Math.max(0, ...solo) > 0 ? pick(solo, (a, b) => a > b) : null,
    },
    distribution: distribution(people, grouping),
  };
}
