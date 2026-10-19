// Team stats (docs/specs/analytics-team-stats.md): the personal figures
// averaged over the team's included members. No member's name, event or
// single value appears here.

import { useEffect, useRef, useState } from "preact/hooks";
import type { Bucket } from "../../server/analytics/member.ts";
import { diffDays } from "../../shared/time.ts";
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
  WEEKDAYS,
} from "./stats-range.tsx";
import { StatsTabs } from "./stats-tabs.tsx";

type Figure =
  | Bucket
  | "meetings"
  | "outsideWork"
  | "tasks"
  | "workHabits"
  | "focusHeld"
  | "bookings";

interface TeamStatsData {
  enough: boolean;
  included: number;
  withoutCalendar: number;
  analyticsOnly: boolean;
  grouping?: "day" | "week";
  averages?: Record<Figure, number>;
  trend?: { start: string; end: string; minutes: Record<Bucket, number> }[];
  meetingDays?: { heaviest: number | null; lightest: number | null };
  focusDays?: { minutes: number[]; mostProductive: number | null };
  distribution?: { unit: "week" | "day"; thresholds: number[]; percent: number[] };
}

const LABELS: Record<Bucket, string> = {
  oneOnOne: "One-on-one meetings",
  teamMeetings: "Team meetings",
  externalMeetings: "External meetings",
  deepWork: "Deep work",
  shallowWork: "Shallow work",
  personal: "Personal",
  travel: "Travel",
  breaks: "Breaks",
  vacation: "Vacation",
  personalCommitment: "Personal commitments",
  free: "Free work time",
};
const COLORS: Record<Bucket, string> = {
  oneOnOne: "var(--meeting)",
  teamMeetings: "color-mix(in srgb, var(--meeting) 70%, #000)",
  externalMeetings: "color-mix(in srgb, var(--meeting) 50%, #fff)",
  deepWork: "var(--focus)",
  shallowWork: "color-mix(in srgb, var(--focus) 50%, #fff)",
  personal: "var(--habit)",
  travel: "var(--task)",
  breaks: "var(--buffer)",
  vacation: "var(--external)",
  personalCommitment: "color-mix(in srgb, var(--external) 50%, #fff)",
  free: "transparent",
};
const ORDER = Object.keys(LABELS) as Bucket[];
const STACKED = ORDER.filter((b) => b !== "free");

type Grouping = "auto" | "day" | "week";

function Row(props: { label: string; figure: Figure; value: number; unit: string }) {
  return (
    <div class="row">
      <span>{props.label}</span>
      <span>
        <strong data-testid={`avg-${props.figure}`}>{hours(props.value)}</strong>
        <span class="meta"> per member, per {props.unit}</span>
      </span>
    </div>
  );
}

export function TeamStats() {
  const picks = quickRanges(zone());
  const q = query();
  const [range, setRange] = useState<Range>(
    q.get("from") && q.get("to")
      ? [q.get("from") as string, q.get("to") as string]
      : (picks["Last 2 weeks"] as Range),
  );
  const [grouping, setGrouping] = useState<Grouping>((q.get("grouping") as Grouping) ?? "auto");
  const [data, setData] = useState<TeamStatsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The address changes at once, so a reload keeps the choice; a refused range puts the last good one back.
  const latest = useRef(0);
  const good = useRef(query());
  // The newest choice; handlers read it, not the last rendered state.
  const current = useRef<{ range: Range; grouping: Grouping }>({ range, grouping });
  const load = async (r: Range, g: Grouping) => {
    const n = ++latest.current;
    current.current = { range: r, grouping: g };
    const resolved = g === "auto" ? (diffDays(r[0], r[1]) < 14 ? "day" : "week") : g;
    const q = new URLSearchParams({ from: r[0], to: r[1], grouping: g });
    setRange(r);
    setGrouping(g);
    saveQuery(q);
    try {
      const d = await api<TeamStatsData>(
        "GET",
        `/api/stats/team?from=${r[0]}&to=${r[1]}&grouping=${resolved}`,
      );
      if (n !== latest.current) return;
      good.current = q;
      setData(d);
      setError(null);
    } catch (err) {
      if (n !== latest.current) return;
      saveQuery(good.current);
      const code = err instanceof ApiError ? (err.body as { error?: string })?.error : undefined;
      setError(RANGE_ERRORS[code ?? ""] ?? "Could not load team stats.");
    }
  };
  // The first load runs after the first paint; a choice made before it wins.
  useEffect(() => {
    if (latest.current === 0) void load(range, grouping);
  }, []);

  const unit = data?.grouping ?? "day";
  const a = data?.averages;
  return (
    <div class="page" data-testid="team-stats">
      <h1>Stats</h1>
      <StatsTabs />
      <div class="actions">
        <RangeControls
          picks={picks}
          range={range}
          onRange={(r) => void load(r, current.current.grouping)}
        />
        <label class="inline">
          Group by
          <select
            aria-label="Group by"
            value={grouping}
            onChange={(e) => void load(current.current.range, e.currentTarget.value as Grouping)}
          >
            <option value="auto">Auto</option>
            <option value="day">By day</option>
            <option value="week">By week</option>
          </select>
        </label>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {data?.analyticsOnly && (
        <p class="meta" data-testid="analytics-only">
          Your seat is analytics only: your calendar counts in team analytics, and the scheduler
          does not change it.
        </p>
      )}
      {data && (
        <p class="meta" data-testid="included">
          {data.included} {data.included === 1 ? "member" : "members"} included
          {data.withoutCalendar ? ` · ${data.withoutCalendar} without calendar data` : ""}
        </p>
      )}
      {data && !data.enough && <p>Not enough members for team stats.</p>}
      {data?.enough && a && (
        <>
          <p class="meta">
            Every figure is an average over the included members. Each member's days follow their
            own time zone.
          </p>
          <h2>Time breakdown</h2>
          <div class="list" data-testid="breakdown">
            <Row label="Meetings" figure="meetings" value={a.meetings} unit={unit} />
            {ORDER.map((b) => (
              <Row key={b} label={LABELS[b]} figure={b} value={a[b]} unit={unit} />
            ))}
          </div>

          <h2>Trend</h2>
          <div class="trend" data-testid="trend">
            {(() => {
              const trend = data.trend ?? [];
              const max = Math.max(
                1,
                ...trend.map((t) => STACKED.reduce((s, b) => s + t.minutes[b], 0)),
              );
              return trend.map((t) => (
                <div class="trend-col" key={t.start} data-date={t.start}>
                  <div class="trend-bar">
                    {STACKED.map((b) =>
                      t.minutes[b] >= 0.5 ? (
                        <div
                          key={b}
                          data-cat={b}
                          style={{
                            height: `${(t.minutes[b] / max) * 160}px`,
                            background: COLORS[b],
                          }}
                          title={`${LABELS[b]}: ${hours(t.minutes[b])}`}
                        />
                      ) : null,
                    )}
                  </div>
                  <div class="meta">{t.start.slice(5)}</div>
                </div>
              ));
            })()}
          </div>

          <h2>Meeting breakdown</h2>
          <div class="list">
            <div class="row">
              <span>Heaviest meeting day</span>
              <strong data-testid="heaviest-day">
                {data.meetingDays?.heaviest ? WEEKDAYS[data.meetingDays.heaviest - 1] : "None"}
              </strong>
            </div>
            <div class="row">
              <span>Lightest meeting day</span>
              <strong data-testid="lightest-day">
                {data.meetingDays?.lightest ? WEEKDAYS[data.meetingDays.lightest - 1] : "None"}
              </strong>
            </div>
          </div>

          <h2>Time in meetings</h2>
          <p class="meta">
            Share of members whose meeting hours per{" "}
            {data.distribution?.unit === "week" ? "week" : "workday"} reach each threshold.
          </p>
          <table class="report heat" data-testid="time-in-meetings">
            <thead>
              <tr>
                {data.distribution?.thresholds.map((t) => (
                  <th key={t}>{t} h or more</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {data.distribution?.percent.map((p, i) => (
                  <td
                    key={data.distribution?.thresholds[i]}
                    data-threshold={data.distribution?.thresholds[i]}
                    style={{
                      background: `color-mix(in srgb, var(--meeting) ${p}%, transparent)`,
                    }}
                  >
                    {p}%
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

          <h2>Focus time</h2>
          <table class="report heat" data-testid="focus-heat">
            <thead>
              <tr>
                {WEEKDAYS.map((w) => (
                  <th key={w}>{w.slice(0, 3)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {(data.focusDays?.minutes ?? []).map((m, i) => {
                  const top = Math.max(1, ...(data.focusDays?.minutes ?? []));
                  return (
                    <td
                      key={WEEKDAYS[i]}
                      style={{
                        background: `color-mix(in srgb, var(--focus) ${Math.round((m / top) * 100)}%, transparent)`,
                      }}
                    >
                      {hours(m)}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
          <div class="list">
            <div class="row">
              <span>Most productive day</span>
              <strong data-testid="productive-day">
                {data.focusDays?.mostProductive
                  ? WEEKDAYS[data.focusDays.mostProductive - 1]
                  : "None"}
              </strong>
            </div>
          </div>

          <h2>Work-life balance</h2>
          <div class="list">
            <Row
              label="Meetings outside work hours"
              figure="outsideWork"
              value={a.outsideWork}
              unit={unit}
            />
          </div>

          <h2>Work habits and tasks</h2>
          <div class="list">
            <Row label="Tasks" figure="tasks" value={a.tasks} unit={unit} />
            <Row label="Work habits" figure="workHabits" value={a.workHabits} unit={unit} />
          </div>

          <h2>Highlights</h2>
          <div class="list">
            <Row label="Focus time held" figure="focusHeld" value={a.focusHeld} unit={unit} />
            <div class="row">
              <span>Meetings booked through links</span>
              <span>
                <strong data-testid="avg-bookings">{a.bookings.toFixed(1)}</strong>
                <span class="meta"> per member, per {unit}</span>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
