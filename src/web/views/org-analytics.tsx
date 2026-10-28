// Organization analytics (docs/specs/analytics-organization.md), for team
// admins: reports by company, department, manager line or person, filters
// from directory attributes, week-over-week trends, CSV export, meeting cost
// salaries and analytics-only seats.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { zone } from "../lib/state.ts";
import {
  hours,
  query,
  quickRanges,
  RANGE_ERRORS,
  type Range,
  RangeControls,
  saveQuery,
} from "./stats-range.tsx";
import { StatsTabs } from "./stats-tabs.tsx";
import "./pages.css";

interface Metrics {
  meetings: number;
  oneOnOne: number;
  teamMeetings: number;
  externalMeetings: number;
  dailyMeetingLoad: number;
  focus: number;
  deepWork: number;
  focusSession: number | null;
  fragmented: number;
  free: number;
  travel: number;
  breaks: number;
  score: number | null;
  cost: number;
}

interface Report {
  attributes: { key: string; values: string[] }[];
  periods: { start: string; end: string }[];
  groups: {
    label: string;
    people: number;
    withoutCalendar: number;
    periods: (Metrics | null)[];
  }[];
  salaries: { defaultSalary: number; byDepartment: Record<string, number> };
}

interface Seat {
  userId: string;
  name: string;
  email: string;
  analyticsOnly: boolean;
}

type Kind = "hours" | "score" | "money";
const METRICS: [keyof Metrics, string, Kind][] = [
  ["meetings", "Meeting time", "hours"],
  ["oneOnOne", "One-on-one meetings", "hours"],
  ["teamMeetings", "Team meetings", "hours"],
  ["externalMeetings", "External meetings", "hours"],
  ["dailyMeetingLoad", "Average daily meeting load (per workday)", "hours"],
  ["focus", "Focus time", "hours"],
  ["deepWork", "Deep work (sessions of 2 h or more)", "hours"],
  ["focusSession", "Average focus session (length)", "hours"],
  ["fragmented", "Fragmented time (per workday)", "hours"],
  ["free", "Free work time", "hours"],
  ["travel", "Travel time", "hours"],
  ["breaks", "Break time", "hours"],
  ["score", "Deep work score (0 to 100)", "score"],
  ["cost", "Meeting cost (whole group)", "money"],
];

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const show = (v: number | null, kind: Kind) =>
  v === null ? "–" : kind === "hours" ? hours(v) : kind === "money" ? money(v) : String(v);
const change = (a: number | null, b: number | null, kind: Kind) => {
  if (a === null || b === null) return "–";
  const d = kind === "hours" ? Math.round(b) - Math.round(a) : Math.round(b - a);
  if (d === 0) return "0";
  return `${d > 0 ? "+" : "-"}${show(Math.abs(d), kind)}`;
};
const day = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/** Grouping choices: the four report levels, then every other directory attribute. */
const LEVELS: [string, string][] = [
  ["", "Company"],
  ["department", "Department"],
  ["manager", "Manager line"],
  ["person", "Person"],
];

function SalaryForm(props: { report: Report; onSaved: () => void }) {
  const { report } = props;
  const departments = report.attributes.find((a) => a.key === "department")?.values ?? [];
  const [saved, setSaved] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const byDepartment: Record<string, number> = {};
    for (const d of departments) {
      const v = Number(f.get(`dept:${d}`));
      if (v > 0) byDepartment[d] = v;
    }
    await api("PUT", "/api/analytics/settings", {
      defaultSalary: Number(f.get("defaultSalary")),
      byDepartment,
    });
    setSaved(true);
    props.onSaved();
  };
  return (
    <form class="form" data-testid="meeting-cost-settings" onSubmit={submit}>
      <p class="meta wide">
        Meeting cost is meeting hours times each person's hourly cost: annual salary / 1920 (48
        weeks of 40 hours), salary only.
      </p>
      <label>
        Default annual salary
        <input
          name="defaultSalary"
          type="number"
          min="1"
          required
          defaultValue={String(report.salaries.defaultSalary)}
          onInput={() => setSaved(false)}
        />
      </label>
      {departments.map((d) => (
        <label key={d}>
          Annual salary in {d}
          <input
            name={`dept:${d}`}
            type="number"
            min="1"
            placeholder="Default"
            defaultValue={
              report.salaries.byDepartment[d] ? String(report.salaries.byDepartment[d]) : ""
            }
            onInput={() => setSaved(false)}
          />
        </label>
      ))}
      <div class="actions wide">
        <button type="submit">Save salaries</button>
        {saved && (
          <span class="meta" data-testid="salaries-saved">
            Saved
          </span>
        )}
      </div>
    </form>
  );
}

function Seats() {
  const [seats, setSeats] = useState<Seat[]>([]);
  const [saved, setSaved] = useState(false);
  const load = () => void api<Seat[]>("GET", "/api/analytics/seats").then(setSeats);
  useEffect(load, []);
  return (
    <div class="list" data-testid="seats">
      {seats.map((s) => (
        <div class="row" key={s.userId} data-seat={s.email}>
          <span>
            {s.name} <span class="meta">{s.email}</span>
          </span>
          <label class="inline">
            <input
              type="checkbox"
              checked={s.analyticsOnly}
              onChange={async (e) => {
                const on = e.currentTarget.checked;
                setSaved(false);
                setSeats((all) =>
                  all.map((x) => (x.userId === s.userId ? { ...x, analyticsOnly: on } : x)),
                );
                await api("PUT", `/api/analytics/seats/${s.userId}`, { analyticsOnly: on });
                setSaved(true);
              }}
            />
            Analytics only
          </label>
        </div>
      ))}
      {saved && (
        <span class="meta" data-testid="seats-saved">
          Saved
        </span>
      )}
    </div>
  );
}

interface Controls {
  range: Range;
  groupBy: string;
  filters: Record<string, string>;
}

const params = (c: Controls) => {
  const p = new URLSearchParams({ from: c.range[0], to: c.range[1], groupBy: c.groupBy });
  for (const [k, v] of Object.entries(c.filters)) if (v) p.append("filter", `${k}=${v}`);
  return p;
};

export function OrgAnalytics() {
  const picks = quickRanges(zone());
  const [controls, setControls] = useState<Controls>(() => {
    const q = query();
    const filters: Record<string, string> = {};
    for (const f of q.getAll("filter")) {
      const i = f.indexOf("=");
      if (i > 0) filters[f.slice(0, i)] = f.slice(i + 1);
    }
    return {
      range:
        q.get("from") && q.get("to")
          ? [q.get("from") as string, q.get("to") as string]
          : (picks["Last 4 weeks"] as Range),
      groupBy: q.get("groupBy") ?? "",
      filters,
    };
  });
  const [report, setReport] = useState<Report | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The address changes at once, so a reload keeps the choice; a refused range puts the last good one back.
  const latest = useRef(0);
  const good = useRef(query());
  // The newest choice; handlers read it, not the last rendered state.
  const current = useRef(controls);
  const load = async (c: Controls) => {
    const n = ++latest.current;
    current.current = c;
    setControls(c);
    saveQuery(params(c));
    try {
      const r = await api<Report>("GET", `/api/analytics/org?${params(c)}`);
      if (n !== latest.current) return;
      good.current = params(c);
      setReport(r);
      setError(null);
    } catch (err) {
      if (n !== latest.current) return;
      saveQuery(good.current);
      if (err instanceof ApiError && err.status === 403) return setDenied(true);
      const code = err instanceof ApiError ? (err.body as { error?: string })?.error : undefined;
      setError(RANGE_ERRORS[code ?? ""] ?? "Could not load the report.");
    }
  };
  // The first load runs after the first paint; a choice made before it wins.
  useEffect(() => {
    if (latest.current === 0) void load(controls);
  }, []);

  const shell = (body: ComponentChildren) => (
    <div class="page" data-testid="org-analytics">
      <h1>Stats</h1>
      <StatsTabs />
      {body}
    </div>
  );
  if (denied)
    return shell(
      <p>
        Organization analytics are for team admins. Ask an admin of your team for access; your own
        figures are under My stats.
      </p>,
    );
  const others = (report?.attributes ?? []).filter(
    (a) => a.key !== "department" && a.key !== "manager",
  );
  const n = report?.periods.length ?? 0;
  return shell(
    <>
      <div class="actions">
        <RangeControls
          picks={picks}
          range={controls.range}
          onRange={(range) => void load({ ...current.current, range })}
        />
        <label class="inline">
          Group by
          <select
            aria-label="Group by"
            value={controls.groupBy}
            onChange={(e) => void load({ ...current.current, groupBy: e.currentTarget.value })}
          >
            {[...LEVELS, ...others.map((a): [string, string] => [a.key, a.key])].map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        {report && (
          <a class="button" href={`/api/analytics/org.csv?${params(controls)}`} download>
            Export CSV
          </a>
        )}
      </div>
      {report && report.attributes.length > 0 && (
        <div class="actions" data-testid="filters">
          {report.attributes.map((a) => (
            <label class="inline" key={a.key}>
              Filter by {a.key}
              <select
                aria-label={`Filter by ${a.key}`}
                value={controls.filters[a.key] ?? ""}
                onChange={(e) =>
                  void load({
                    ...current.current,
                    filters: { ...current.current.filters, [a.key]: e.currentTarget.value },
                  })
                }
              >
                <option value="">All</option>
                {a.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <p class="meta">
            Hours are per person per week unless the row says otherwise. These figures describe
            group patterns; they are not a rating of one person.
          </p>
          {report.groups.length === 0 && <p>Nobody matches these filters.</p>}
          {report.groups.map((g) => (
            <section key={g.label} data-group={g.label}>
              <h2>
                {g.label}{" "}
                <span class="meta">
                  ·{" "}
                  <span data-testid="people">
                    {g.people} {g.people === 1 ? "person" : "people"}
                  </span>
                  {g.withoutCalendar ? ` · ${g.withoutCalendar} without calendar data` : ""}
                </span>
              </h2>
              {g.periods[0] === null ? (
                <p class="meta">
                  {g.people === 0 ? "No calendar data." : "Fewer than 3 people: no values."}
                </p>
              ) : (
                <table class="report">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      {report.periods.map((p) => (
                        <th key={p.start}>
                          {day(p.start)} – {day(p.end)}
                        </th>
                      ))}
                      {n > 1 && <th>Week over week</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {METRICS.map(([key, label, kind]) => (
                      <tr key={key} data-metric={key}>
                        <th>{label}</th>
                        {g.periods.map((m, i) => (
                          <td key={report.periods[i]?.start} data-period={i}>
                            {show(m ? m[key] : null, kind)}
                          </td>
                        ))}
                        {n > 1 && (
                          <td data-testid="change">
                            {change(
                              g.periods[n - 2]?.[key] ?? null,
                              g.periods[n - 1]?.[key] ?? null,
                              kind,
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
          <p class="meta" data-testid="benchmark">
            Industry benchmark: no benchmark data yet.
          </p>
          <p class="meta">
            Groups use each person's current directory attributes. People without calendar data are
            left out of every figure. The deep work score is 25 × (share of work hours without
            meetings + share of workdays under 4 h of meetings + share of free time in blocks of 2 h
            or more + share of free time that is not fragmented).
          </p>
          <section>
            <h2>Meeting cost</h2>
            <SalaryForm report={report} onSaved={() => void load(controls)} />
          </section>
          <section>
            <h2>Analytics-only seats</h2>
            <p class="meta">
              An analytics-only member's calendar counts in team and organization analytics. The
              scheduler never changes it.
            </p>
            <Seats />
          </section>
        </>
      )}
    </>,
  );
}
