// Policy reports (docs/specs/teams-policies.md rules 8, 11, 13, 20, 22, 24): the
// goal, a baseline of the 4 weeks before the policy started, and weekly group
// averages. Reports never show one member's value or name
// (analytics-team-stats.md rule 2).
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import { type Interval, TimeSet } from "../../scheduler/timeset.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { fragmentedMinutes } from "../analytics/fragmentation.ts";
import { all, type Db, one } from "../db.ts";
import { directoryAttributes } from "../directory.ts";
import { categoryContext, externalCategory } from "../planner/categories.ts";
import { getSettings } from "../settings.ts";
import { hasAgenda } from "./agendas.ts";
import { MEETING_CATEGORIES, membersInScope, type Policy } from "./model.ts";

export type Format = "hours" | "count" | "percent" | "minutes";

export interface Metric {
  id: string;
  label: string;
  format: Format;
  /** Week start date -> value; null when there is nothing to average. */
  values: Record<string, number | null>;
}

export interface Report {
  members: number;
  weeks: { start: LocalDate; baseline: boolean }[];
  metrics: Metric[];
  notes: string[];
  baseline?: {
    groupBy: string;
    days: LocalDate[];
    groups: { name: string; values: Record<string, number> }[];
  };
}

const HOUR = 3_600_000;
const MIN = 60_000;
const BASELINE_WEEKS = 4;
const MAX_POLICY_WEEKS = 12;

interface EventRow {
  calendar_id: string;
  event_id: string;
  summary: string;
  description: string;
  start_ms: number;
  end_ms: number;
  all_day: number;
  busy: number;
  event_type: string;
  self_response: string | null;
  attendees: string;
  recurring_id: string | null;
  private_props: string;
  rsvp_note: string;
}

interface Member {
  id: string;
  zone: string;
  hours: WeeklyHours;
  events: (EventRow & { managed: boolean; category: string })[];
  managed: { kind: string; source_id: string; key: string; start_ms: number; end_ms: number }[];
}

function weekStartOf(zone: string, t: number, weekStart: 1 | 7): LocalDate {
  const d = utcToLocal(zone, t).date;
  return addDays(d, -((weekdayOf(d) - weekStart + 7) % 7));
}

function loadMember(db: Db, id: string, from: number, to: number): Member {
  const user = one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", id);
  const hours = one<{ weekly: string }>(
    db,
    "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
    id,
  );
  const events = all<EventRow>(
    db,
    `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?`,
    id,
    from,
    to,
  );
  const ctx = categoryContext(db, id);
  return {
    id,
    zone: user?.time_zone ?? "UTC",
    hours: hours ? (JSON.parse(hours.weekly) as WeeklyHours) : {},
    events: events.map((e) => ({
      ...e,
      managed: (JSON.parse(e.private_props) as Record<string, string>).tl === "1",
      category: externalCategory(ctx, e),
    })),
    managed: all(
      db,
      `SELECT kind, source_id, key, start_ms, end_ms FROM managed_events
       WHERE user_id = ? AND end_ms > ? AND start_ms < ?`,
      id,
      from,
      to,
    ),
  };
}

const overlap = (a: Interval, b: Interval) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Events the member attends with other people (meeting categories), not managed by Tempoloom. */
const meetingsOf = (m: Member, range: Interval, types: readonly string[] = MEETING_CATEGORIES) =>
  m.events.filter(
    (e) =>
      !e.managed &&
      !e.all_day &&
      e.busy &&
      e.self_response !== "declined" &&
      types.includes(e.category) &&
      e.start_ms >= range.start &&
      e.start_ms < range.end,
  );

const focusMinutes = (m: Member, range: Interval, keptBefore?: number) =>
  m.managed
    .filter(
      (r) =>
        r.kind === "focus" &&
        r.start_ms >= range.start &&
        r.start_ms < range.end &&
        (keptBefore === undefined || r.end_ms <= keptBefore),
    )
    .reduce((a, r) => a + (r.end_ms - r.start_ms), 0) / MIN;

const average = (values: number[]) =>
  values.length === 0 ? null : values.reduce((a, v) => a + v, 0) / values.length;
const share = (part: number, whole: number) => (whole === 0 ? null : (100 * part) / whole);

/** Work-hours ranges of one local date in the member's zone. */
function workRanges(m: Member, date: LocalDate): Interval[] {
  return [
    ...hoursToTimeSet(
      m.hours,
      m.zone,
      localToUtc(m.zone, date, 0),
      localToUtc(m.zone, addDays(date, 1), 0),
    ).intervals(),
  ];
}

interface DayFacts {
  fragmented: number;
  usable: number;
  blocks: number[];
  meetings: number;
}

/** Rule 21 and 24: fragmented and usable minutes of one workday, or null on a day off. */
function dayFacts(m: Member, date: LocalDate, minBlock: number): DayFacts | null {
  const ranges = workRanges(m, date);
  if (ranges.length === 0) return null;
  const busy = m.events
    .filter((e) => !e.all_day && e.busy && e.self_response !== "declined")
    .map((e) => ({ start: e.start_ms, end: e.end_ms }));
  const fragmented = fragmentedMinutes(busy, ranges, minBlock);
  const free = TimeSet.from(ranges);
  for (const b of busy) free.subtract(b);
  const blocks = free.intervals().map((i) => (i.end - i.start) / MIN);
  const day = { start: ranges[0]?.start ?? 0, end: ranges.at(-1)?.end ?? 0 };
  return {
    fragmented,
    usable: blocks.reduce((a, b) => a + b, 0) - fragmented,
    blocks,
    meetings: meetingsOf(m, day).length,
  };
}

/** The report of one policy, in the viewer's zone and week start. */
export function policyReport(
  db: Db,
  policy: Policy,
  viewerId: string,
  now: number,
  groupBy?: string,
): Report {
  const zone =
    one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", viewerId)
      ?.time_zone ?? "UTC";
  const weekStart = getSettings(db, viewerId).weekStart;
  const startWeek = weekStartOf(zone, policy.startedAt ?? now, weekStart);
  const lastWeek = addDays(weekStartOf(zone, now, weekStart), 14);
  const weeks: Report["weeks"] = [];
  for (let i = BASELINE_WEEKS; i > 0; i--)
    weeks.push({ start: addDays(startWeek, -7 * i), baseline: true });
  const policyWeeks: LocalDate[] = [];
  for (let w = startWeek; w <= lastWeek; w = addDays(w, 7)) policyWeeks.push(w);
  for (const w of policyWeeks.slice(-MAX_POLICY_WEEKS)) weeks.push({ start: w, baseline: false });
  const rangeOf = (w: LocalDate): Interval => ({
    start: localToUtc(zone, w, 0),
    end: localToUtc(zone, addDays(w, 7), 0),
  });
  const from = rangeOf(weeks[0]?.start ?? startWeek).start;
  const to = rangeOf(weeks.at(-1)?.start ?? startWeek).end;
  const ids = membersInScope(db, policy).filter((id) =>
    one(db, "SELECT 1 FROM accounts WHERE user_id = ? AND status = 'ok'", id),
  );
  const members = ids.map((id) => loadMember(db, id, from, to));
  const metric = (
    id: string,
    label: string,
    format: Format,
    value: (range: Interval, week: LocalDate) => number | null,
  ): Metric => ({
    id,
    label,
    format,
    values: Object.fromEntries(weeks.map((w) => [w.start, value(rangeOf(w.start), w.start)])),
  });
  const perMember = (f: (m: Member, range: Interval) => number) => (range: Interval) =>
    average(members.map((m) => f(m, range)));
  const report: Report = { members: members.length, weeks, metrics: [], notes: [] };

  if (policy.type === "focus_time") {
    const goals = members.map((m) => {
      const own = one<{ weekly_goal_minutes: number }>(
        db,
        `SELECT f.weekly_goal_minutes FROM policy_automations a JOIN focus_goals f ON f.id = a.item_id
         WHERE a.policy_id = ? AND a.user_id = ? AND a.kind = 'focus'`,
        policy.id,
        m.id,
      );
      return (own?.weekly_goal_minutes ?? policy.goal.weeklyGoalMinutes) / 60;
    });
    report.metrics.push(
      metric("goalHours", "Members' weekly goal (h)", "hours", () => average(goals)),
      metric(
        "focusScheduledHours",
        "Focus scheduled (h)",
        "hours",
        perMember((m, r) => focusMinutes(m, r) / 60),
      ),
      metric(
        "focusKeptHours",
        "Focus kept (h)",
        "hours",
        perMember((m, r) => focusMinutes(m, r, now) / 60),
      ),
      metric(
        "meetingHours",
        "Meetings (h)",
        "hours",
        perMember(
          (m, r) =>
            meetingsOf(m, r).reduce(
              (a, e) => a + overlap({ start: e.start_ms, end: e.end_ms }, r),
              0,
            ) / HOUR,
        ),
      ),
    );
    report.notes.push(`Policy goal: ${policy.goal.weeklyGoalMinutes / 60} h per week.`);
  } else if (policy.type === "buffers") {
    const g = policy.goal;
    const types = [...g.prepBefore, ...g.followUpAfter, ...g.recoveryAfter].map((r) => r.category);
    const buffersOf = new Map(
      members.map((m) => [
        m.id,
        all<{ item_id: string }>(
          db,
          "SELECT item_id FROM policy_automations WHERE policy_id = ? AND user_id = ? AND kind = 'buffer'",
          policy.id,
          m.id,
        ).map((r) => r.item_id),
      ]),
    );
    report.metrics.push(
      metric("bufferCoveragePercent", "Meetings with a policy buffer (%)", "percent", (r) => {
        let total = 0;
        let covered = 0;
        for (const m of members) {
          const ids = new Set(buffersOf.get(m.id));
          for (const e of meetingsOf(m, r, types)) {
            total++;
            if (
              m.managed.some(
                (b) =>
                  b.kind === "buffer" && ids.has(b.source_id) && b.key.includes(`:${e.event_id}:`),
              )
            )
              covered++;
          }
        }
        return share(covered, total);
      }),
    );
    const removed = members.reduce(
      (a, m) =>
        a +
        (buffersOf.get(m.id) ?? []).reduce(
          (n, id) =>
            n +
            (one<{ n: number }>(
              db,
              "SELECT count(*) AS n FROM dismissed_keys WHERE user_id = ? AND key LIKE ?",
              m.id,
              `buffer:${id}:%`,
            )?.n ?? 0),
          0,
        ),
      0,
    );
    report.notes.push(
      `Policy buffers members removed: ${members.length ? (removed / members.length).toFixed(1) : "0.0"} per member.`,
    );
  } else if (policy.type === "meeting_agendas") {
    const types = policy.goal.meetingTypes;
    const pooled = (r: Interval) => members.flatMap((m) => meetingsOf(m, r, types));
    report.metrics.push(
      metric(
        "meetings",
        "Meetings per member",
        "count",
        perMember((m, r) => meetingsOf(m, r, types).length),
      ),
      metric("withAgendaPercent", "Meetings with an agenda (%)", "percent", (r) => {
        const list = pooled(r);
        return share(list.filter((e) => hasAgenda(e.description)).length, list.length);
      }),
      metric(
        "declined",
        "Declined for no agenda, per member",
        "count",
        perMember(
          (m, r) =>
            one<{ n: number }>(
              db,
              `SELECT count(*) AS n FROM agenda_actions WHERE user_id = ? AND kind = 'declined'
               AND start_ms >= ? AND start_ms < ?`,
              m.id,
              r.start,
              r.end,
            )?.n ?? 0,
        ),
      ),
      metric("averageMeetingMinutes", "Average meeting length (min)", "minutes", (r) =>
        average(pooled(r).map((e) => (e.end_ms - e.start_ms) / MIN)),
      ),
      metric(
        "focusKeptHours",
        "Focus kept (h)",
        "hours",
        perMember((m, r) => focusMinutes(m, r, now) / 60),
      ),
    );
  } else {
    const minBlock = policy.goal.minUsableBlockMinutes;
    const days = (w: LocalDate) => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(w, i));
    const facts = (w: LocalDate) =>
      members.flatMap((m) =>
        days(w)
          .map((d) => dayFacts(m, d, minBlock))
          .filter((f): f is DayFacts => f !== null),
      );
    report.metrics.push(
      metric("fragmentedMinutes", "Fragmented time per workday (min)", "minutes", (_r, w) =>
        average(facts(w).map((f) => f.fragmented)),
      ),
      metric("usableMinutes", "Usable time per workday (min)", "minutes", (_r, w) =>
        average(facts(w).map((f) => f.usable)),
      ),
      metric("averageBlockMinutes", "Average free block (min)", "minutes", (_r, w) =>
        average(facts(w).flatMap((f) => f.blocks)),
      ),
      metric("meetingsPerDay", "Meetings per workday", "count", (_r, w) =>
        average(facts(w).map((f) => f.meetings)),
      ),
    );
    report.notes.push(
      `Target: ${policy.goal.targetReductionPercent}% less fragmented time than the baseline; gaps under ${minBlock} minutes count.`,
    );
    if (groupBy) {
      const attrs = directoryAttributes(db, policy.teamId);
      const key = groupBy.trim().toLowerCase();
      const groupOf = (id: string) =>
        Object.entries(attrs.get(id) ?? {}).find(([k]) => k.toLowerCase() === key)?.[1] ??
        `No ${groupBy.trim()}`;
      const groups = new Map<string, Member[]>();
      for (const m of members) groups.set(groupOf(m.id), [...(groups.get(groupOf(m.id)) ?? []), m]);
      const baselineDays = weeks
        .filter((w) => w.baseline)
        .flatMap((w) => days(w.start))
        .filter((d) => members.some((m) => workRanges(m, d).length > 0));
      report.baseline = {
        groupBy: groupBy.trim(),
        days: baselineDays,
        groups: [...groups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, list]) => ({
            name,
            values: Object.fromEntries(
              baselineDays.map((d) => [
                d,
                Math.round(
                  average(
                    list
                      .map((m) => dayFacts(m, d, minBlock))
                      .filter((f): f is DayFacts => f !== null)
                      .map((f) => f.fragmented),
                  ) ?? 0,
                ),
              ]),
            ),
          })),
      };
    }
  }
  return report;
}
