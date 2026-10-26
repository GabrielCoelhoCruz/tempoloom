// Organization reports (docs/specs/analytics-organization.md): people of a
// team grouped and filtered by directory attributes, with metrics per 7-day
// period, a privacy guard of 3 people, and a CSV export.
import { addDays, diffDays, type LocalDate } from "../../shared/time.ts";
import { all, type Db, one, run } from "../db.ts";
import { type Attributes, directoryAttributes } from "../directory.ts";
import { loadMemberDays } from "./member.ts";
import { groupMetrics, HOURS_PER_YEAR, type Metrics, periods } from "./metrics.ts";

/** Groups with fewer people show no values (rule 10, edge case 3). */
export const MIN_GROUP = 3;
/** Directory fields that identify a person; never filters or groups. */
const IDENTITY = new Set(["userName", "displayName", "name", "email", "emails", "active", "id"]);
export const DEFAULT_SALARY = 100_000;

export interface TeamPerson {
  userId: string;
  name: string;
  email: string;
  hasCalendar: boolean;
}

/** Active members of a team; `hasCalendar` marks the ones whose calendar can be analyzed. */
export const teamPeople = (db: Db, teamId: string) =>
  all<{ userId: string; name: string; email: string; hasCalendar: number }>(
    db,
    `SELECT u.id AS userId, u.name, u.email,
       EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.status = 'ok') AS hasCalendar
     FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND u.deactivated_at IS NULL ORDER BY u.email`,
    teamId,
  ).map((p): TeamPerson => ({ ...p, hasCalendar: p.hasCalendar === 1 }));

export interface Salaries {
  defaultSalary: number;
  /** Annual salary per department (rule 7: per group). */
  byDepartment: Record<string, number>;
}

export function salaries(db: Db, teamId: string): Salaries {
  const row = one<{ default_salary: number; salaries: string }>(
    db,
    "SELECT default_salary, salaries FROM analytics_settings WHERE team_id = ?",
    teamId,
  );
  return {
    defaultSalary: row?.default_salary ?? DEFAULT_SALARY,
    byDepartment: JSON.parse(row?.salaries ?? "{}") as Record<string, number>,
  };
}

export function saveSalaries(db: Db, teamId: string, s: Salaries): void {
  run(
    db,
    `INSERT INTO analytics_settings (team_id, default_salary, salaries) VALUES (?, ?, ?)
     ON CONFLICT (team_id) DO UPDATE SET default_salary = excluded.default_salary, salaries = excluded.salaries`,
    teamId,
    s.defaultSalary,
    JSON.stringify(s.byDepartment),
  );
}

export interface OrgQuery {
  from: LocalDate;
  to: LocalDate;
  /** "" for the company, "person", or a directory attribute ("manager" groups by manager line). */
  groupBy: string;
  filters: [string, string][];
}

export interface OrgGroup {
  label: string;
  people: number;
  withoutCalendar: number;
  /** Metrics per period; null below the privacy guard. */
  periods: (Metrics | null)[];
}

const missing = (key: string) => (key === "manager" ? "No manager" : `No ${key}`);

export function orgReport(db: Db, teamId: string, q: OrgQuery) {
  const attrs = directoryAttributes(db, teamId);
  const people = teamPeople(db, teamId).map((p) => ({
    ...p,
    attributes: attrs.get(p.userId) ?? {},
  }));
  const values = new Map<string, Set<string>>();
  for (const p of people)
    for (const [k, v] of Object.entries(p.attributes))
      if (!IDENTITY.has(k)) values.set(k, (values.get(k) ?? new Set()).add(v));
  const attributes = [...values]
    .map(([key, set]) => ({ key, values: [...set].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const chosen = people.filter((p) => q.filters.every(([k, v]) => p.attributes[k] === v));
  const groups = new Map<string, typeof chosen>();
  const add = (label: string, p: (typeof chosen)[number]) =>
    groups.set(label, [...(groups.get(label) ?? []), p]);
  const byName = new Map(people.map((p) => [p.name, p]));
  for (const p of chosen) {
    if (q.groupBy === "") add("Company", p);
    else if (q.groupBy === "person") add(`${p.name} (${p.email})`, p);
    else if (q.groupBy === "manager") {
      // The manager line: everyone below a manager, directly or not.
      let m: string | undefined = p.attributes.manager;
      if (!m) add(missing("manager"), p);
      const seen = new Set<string>();
      while (m && !seen.has(m)) {
        seen.add(m);
        add(m, p);
        m = byName.get(m)?.attributes.manager;
      }
    } else
      add(
        (Object.hasOwn(p.attributes, q.groupBy) ? p.attributes[q.groupBy] : undefined) ??
          missing(q.groupBy),
        p,
      );
  }
  const length = diffDays(q.from, q.to) + 1;
  const chunks = periods(length, "week");
  const pay = salaries(db, teamId);
  const daysOf = new Map(
    chosen
      .filter((p) => p.hasCalendar)
      .map((p) => [p.userId, loadMemberDays(db, p.userId, q.from, q.to)]),
  );
  const hourly = (a: Attributes) =>
    (pay.byDepartment[a.department ?? ""] ?? pay.defaultSalary) / HOURS_PER_YEAR;
  const isNone = (label: string) => label.startsWith("No ");
  const out: OrgGroup[] = [...groups]
    .sort(([a], [b]) => Number(isNone(a)) - Number(isNone(b)) || a.localeCompare(b))
    .map(([label, members]) => {
      const included = members.filter((p) => p.hasCalendar);
      // Rule 10: an admin sees one person's figures; groups need 3 people.
      const shown = included.length >= (q.groupBy === "person" ? 1 : MIN_GROUP);
      return {
        label,
        people: included.length,
        withoutCalendar: members.length - included.length,
        periods: chunks.map(([a, b]) =>
          shown
            ? groupMetrics(
                included.map((p) => ({
                  days: (daysOf.get(p.userId) ?? []).slice(a, b),
                  hourly: hourly(p.attributes),
                })),
              )
            : null,
        ),
      };
    });
  return {
    from: q.from,
    to: q.to,
    groupBy: q.groupBy,
    filters: q.filters,
    attributes,
    periods: chunks.map(([a, b]) => ({ start: addDays(q.from, a), end: addDays(q.from, b - 1) })),
    groups: out,
    salaries: pay,
  };
}

export type OrgReport = ReturnType<typeof orgReport>;

/** The metrics of a report row: the name (CSV column and chat key), the value, and its CSV text. */
const two = (v: number) => v.toFixed(2);
export const COLUMNS: [string, (m: Metrics) => number | null, (v: number) => string][] = [
  ["meeting_hours_per_person_week", (m) => m.meetings / 60, two],
  ["one_on_one_hours_per_person_week", (m) => m.oneOnOne / 60, two],
  ["team_meeting_hours_per_person_week", (m) => m.teamMeetings / 60, two],
  ["external_meeting_hours_per_person_week", (m) => m.externalMeetings / 60, two],
  ["meeting_hours_per_person_workday", (m) => m.dailyMeetingLoad / 60, two],
  ["focus_hours_per_person_week", (m) => m.focus / 60, two],
  ["deep_work_hours_per_person_week", (m) => m.deepWork / 60, two],
  ["avg_focus_session_minutes", (m) => m.focusSession, two],
  ["fragmented_minutes_per_person_workday", (m) => m.fragmented, two],
  ["free_hours_per_person_week", (m) => m.free / 60, two],
  ["travel_hours_per_person_week", (m) => m.travel / 60, two],
  ["break_hours_per_person_week", (m) => m.breaks / 60, two],
  ["deep_work_score", (m) => m.score, String],
  ["meeting_cost_usd", (m) => Math.round(m.cost), String],
];

/** Personal stats rule 10 and organization analytics: 12 weeks of history, at most 120 days. */
export const HISTORY_DAYS = 84;
export const MAX_SPAN_DAYS = 120;

export type RangeProblem = "invalid_range" | "range_too_long" | "range_too_early";

/**
 * What is wrong with a stats range, or null: the end is before the start, it
 * is longer than MAX_SPAN_DAYS, or it starts more than HISTORY_DAYS before
 * today (in the user's zone). The stats pages, assistant chat and the MCP
 * tools check ranges with it.
 */
export function rangeProblem(
  from: LocalDate,
  to: LocalDate,
  today: LocalDate,
): RangeProblem | null {
  if (to < from) return "invalid_range";
  if (diffDays(from, to) > MAX_SPAN_DAYS) return "range_too_long";
  if (from < addDays(today, -HISTORY_DAYS)) return "range_too_early";
  return null;
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Rule 12: one row per group and period: the group key, period start and end, one column per metric. */
export function reportCsv(r: OrgReport, groupLabel: string): string {
  const lines = [[groupLabel, "people", "period_start", "period_end", ...COLUMNS.map((c) => c[0])]];
  for (const g of r.groups)
    r.periods.forEach((p, i) => {
      const m = g.periods[i];
      lines.push([
        g.label,
        String(g.people),
        p.start,
        p.end,
        ...COLUMNS.map(([, f, text]) => {
          const v = m ? f(m) : null;
          return v === null ? "" : text(v);
        }),
      ]);
    });
  return `${lines.map((l) => l.map(cell).join(",")).join("\r\n")}\r\n`;
}
