// Personal stats panels (docs/specs/analytics-personal-stats.md): time by
// category with deep and shallow work, the weekday panels (rules 4 and 7),
// people met (rule 6), breaks and travel buffers (rule 8), insights (rules
// 12-13) and calendar facts (analytics-weekly-reports.md rule 7). The buckets,
// sessions and free time come from the member figures that team stats use.
import { attends } from "../../scheduler/blocking.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { all, type Db, one } from "../db.ts";
import { categoryContext, externalCategory } from "../planner/categories.ts";
import { MANAGED_PROP } from "../planner/push.ts";
import { BUCKETS, type Bucket, loadMemberDays } from "./member.ts";
import { loadPlannedVersusActual } from "./planned.ts";

const MIN = 60_000;
/** A solo session shorter than this is focus time in a short piece (rule 13). */
const DEEP_MINUTES = 120;
/** Insights: a day with this many meetings, or this many meeting minutes, has many meetings. */
const MANY_MEETINGS = 3;
const MANY_MEETING_MINUTES = 4 * 60;
const MEETING_CATEGORIES = new Set(["one_on_one", "team_meeting", "external_meeting"]);
export const WEEKDAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const best = <T>(list: T[], key: (x: T) => number, better: (a: number, b: number) => boolean) =>
  list.reduce<T | null>((acc, x) => (acc === null || better(key(x), key(acc)) ? x : acc), null);

export function personalInsights(
  db: Db,
  userId: string,
  from: LocalDate,
  to: LocalDate,
  now: number,
) {
  const user = one<{ time_zone: string; email: string }>(
    db,
    "SELECT time_zone, email FROM users WHERE id = ?",
    userId,
  );
  const zone = user?.time_zone ?? "UTC";
  const self = (user?.email ?? "").toLowerCase();
  const start = localToUtc(zone, from, 0);
  const end = localToUtc(zone, addDays(to, 1), 0);
  const days = loadMemberDays(db, userId, from, to);
  const sum = (b: Bucket) => days.reduce((a, d) => a + d.minutes[b], 0);
  const meetingsOf = (d: (typeof days)[number]) =>
    d.minutes.oneOnOne + d.minutes.teamMeetings + d.minutes.externalMeetings;

  // Meetings the user attends, with their guests, and repeat events (edge case 1: no declined ones).
  const ctx = categoryContext(db, userId);
  const met = new Map<string, number>();
  const meetingsPerDay = new Map<LocalDate, number>();
  const repeats = new Map<string, { title: string; count: number }>();
  for (const e of all<{
    calendar_id: string;
    event_id: string;
    summary: string;
    description: string;
    start_ms: number;
    end_ms: number;
    event_type: string;
    self_response: "needsAction" | "declined" | "tentative" | "accepted" | null;
    organizer_self: number;
    attendees: string;
    recurring_id: string | null;
    private_props: string;
  }>(
    db,
    `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1 AND e.all_day = 0
       AND e.end_ms > ? AND e.start_ms < ?`,
    userId,
    start,
    end,
  )) {
    if ((JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] === "1") continue;
    const attended = attends({
      selfResponse: e.self_response,
      organizerSelf: e.organizer_self === 1,
    } as Parameters<typeof attends>[0]);
    if (!attended || e.event_type === "workingLocation") continue;
    const key = e.recurring_id ?? e.summary.trim().toLowerCase();
    if (key) {
      const r = repeats.get(key) ?? { title: e.summary, count: 0 };
      r.count++;
      repeats.set(key, r);
    }
    if (!MEETING_CATEGORIES.has(externalCategory(ctx, e))) continue;
    const date = utcToLocal(zone, e.start_ms).date;
    meetingsPerDay.set(date, (meetingsPerDay.get(date) ?? 0) + 1);
    const minutes = (Math.min(e.end_ms, end) - Math.max(e.start_ms, start)) / MIN;
    for (const p of JSON.parse(e.attendees) as string[]) {
      const email = p.toLowerCase();
      if (email !== self) met.set(email, (met.get(email) ?? 0) + minutes);
    }
  }
  // Flexible meetings that Tempoloom places count too.
  for (const m of all<{ start_ms: number; end_ms: number; extra: string }>(
    db,
    "SELECT start_ms, end_ms, extra FROM managed_events WHERE user_id = ? AND kind = 'meeting' AND end_ms > ? AND start_ms < ?",
    userId,
    start,
    end,
  )) {
    const extra = (m.extra ? JSON.parse(m.extra) : {}) as { attendees?: string[] };
    const guests = (extra.attendees ?? []).map((a) => a.toLowerCase()).filter((a) => a !== self);
    if (guests.length === 0) continue;
    const date = utcToLocal(zone, m.start_ms).date;
    meetingsPerDay.set(date, (meetingsPerDay.get(date) ?? 0) + 1);
    const minutes = (Math.min(m.end_ms, end) - Math.max(m.start_ms, start)) / MIN;
    for (const g of guests) met.set(g, (met.get(g) ?? 0) + minutes);
  }
  const people = [...met]
    .map(([email, minutes]) => ({ email, minutes }))
    .sort((a, b) => b.minutes - a.minutes || a.email.localeCompare(b.email));

  // Rule 8: hours of travel buffers, apart from other travel time.
  const travelBuffers = new Set(
    all<{ id: string; filter: string }>(
      db,
      "SELECT id, filter FROM buffers WHERE user_id = ?",
      userId,
    )
      .filter((b) => {
        const f = JSON.parse(b.filter) as { travel?: boolean; flight?: boolean };
        return f.travel || f.flight;
      })
      .map((b) => b.id),
  );
  const travelBufferMinutes = all<{ source_id: string; start_ms: number; end_ms: number }>(
    db,
    "SELECT source_id, start_ms, end_ms FROM managed_events WHERE user_id = ? AND kind = 'buffer' AND end_ms > ? AND start_ms < ?",
    userId,
    start,
    end,
  )
    .filter((b) => travelBuffers.has(b.source_id))
    .reduce((a, b) => a + (Math.min(b.end_ms, end) - Math.max(b.start_ms, start)) / MIN, 0);

  // Weekday panels: the average per weekday over the range.
  const perWeekday = Array.from({ length: 8 }, () => ({
    n: 0,
    solo: 0,
    meetings: 0,
    busy: 0,
    work: 0,
  }));
  for (const d of days) {
    const w = perWeekday[d.weekday] as (typeof perWeekday)[number];
    w.n++;
    w.solo += d.minutes.deepWork + d.minutes.shallowWork;
    w.meetings += meetingsOf(d);
    w.busy += BUCKETS.filter((b) => b !== "free" && b !== "vacation" && b !== "commitment").reduce(
      (a, b) => a + d.minutes[b],
      0,
    );
    w.work += d.work;
  }
  const weekdays = perWeekday.flatMap((w, i) =>
    i === 0 || w.n === 0
      ? []
      : [
          {
            weekday: i,
            name: WEEKDAY_NAMES[i] ?? "",
            solo: w.solo / w.n,
            meetings: w.meetings / w.n,
            workload: w.busy / w.n,
            work: w.work / w.n,
          },
        ],
  );
  const productive = best(
    weekdays,
    (w) => w.solo,
    (a, b) => a > b,
  );
  const busiest = best(
    weekdays,
    (w) => w.meetings,
    (a, b) => a > b,
  );
  const lightest = best(
    weekdays.filter((w) => w.work > 0),
    (w) => w.meetings,
    (a, b) => a < b,
  );

  const sessions = days.flatMap((d) => d.sessions);
  const short = sessions.filter((s) => s < DEEP_MINUTES);
  const busiestDate = best(days, meetingsOf, (a, b) => a > b);
  const longest = Math.max(0, ...sessions);
  const bookings = days.reduce((a, d) => a + d.bookings, 0);
  const breaks = sum("breaks");

  // Calendar facts (weekly report rule 7): up to 4 that apply.
  const facts = [
    busiestDate && meetingsOf(busiestDate) > 0
      ? {
          kind: "busiest_day",
          day: WEEKDAY_NAMES[weekdayOf(busiestDate.date)] ?? "",
          minutes: meetingsOf(busiestDate),
        }
      : null,
    longest > 0 ? { kind: "longest_focus", minutes: longest } : null,
    bookings > 0 ? { kind: "booked_meetings", count: bookings } : null,
    breaks > 0 ? { kind: "breaks", minutes: breaks } : null,
    people.length > 0 ? { kind: "people_met", count: people.length } : null,
  ]
    .filter((f) => f !== null)
    .slice(0, 4);

  return {
    from,
    to,
    categories: {
      one_on_one: sum("oneOnOne"),
      team_meeting: sum("teamMeetings"),
      external_meeting: sum("externalMeetings"),
      deep_work: sum("deepWork"),
      shallow_work: sum("shallowWork"),
      personal: sum("personal"),
      travel: sum("travel"),
      breaks,
      vacation: sum("vacation"),
      personal_commitment: sum("commitment"),
      free: sum("free"),
    },
    weekdays,
    mostProductive: productive && productive.solo > 0 ? productive.name : null,
    busiestMeetingDay:
      busiest && busiest.meetings > 0 ? { name: busiest.name, minutes: busiest.meetings } : null,
    lightestMeetingDay: lightest ? { name: lightest.name, minutes: lightest.meetings } : null,
    people,
    highlights: { breaks, travelBuffers: travelBufferMinutes },
    insights: {
      meetings: sum("oneOnOne") + sum("teamMeetings") + sum("externalMeetings"),
      solo: sum("deepWork") + sum("shallowWork"),
      manyMeetingDays: days
        .map((d) => ({
          date: d.date,
          name: WEEKDAY_NAMES[d.weekday] ?? "",
          meetings: meetingsPerDay.get(d.date) ?? 0,
          minutes: meetingsOf(d),
        }))
        .filter((d) => d.meetings >= MANY_MEETINGS || d.minutes >= MANY_MEETING_MINUTES),
      shortFocus: { pieces: short.length, minutes: short.reduce((a, s) => a + s, 0) },
      repeats: [...repeats.values()]
        .filter((r) => r.count >= 2)
        .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
    },
    facts,
    plannedActual: loadPlannedVersusActual(db, userId, zone, from, to, now),
  };
}
