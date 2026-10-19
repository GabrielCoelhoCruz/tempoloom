import { useEffect, useState } from "preact/hooks";
import { addDays, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { zone } from "../lib/state.ts";
import { StatsTabs } from "./stats-tabs.tsx";

const StatsExtras = lazyComponent<{ from: string; to: string }>(() =>
  import("./stats-extras.tsx").then((m) => m.StatsExtras),
);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Category =
  | "oneOnOne"
  | "groupMeetings"
  | "bookedMeetings"
  | "soloEvents"
  | "tasks"
  | "workHabits"
  | "personalHabits"
  | "focus"
  | "buffers";

interface Stats {
  days: { date: string; minutes: Record<Category, number> }[];
  totals: Record<Category, number>;
  highlights: {
    meetingMinutes: number;
    focusMinutes: number;
    bookings: number;
    meetingMinutesOutsideWorkHours: number;
  };
}

const LABELS: Record<Category, string> = {
  oneOnOne: "One-to-one meetings",
  groupMeetings: "Group meetings",
  bookedMeetings: "Booked meetings",
  soloEvents: "Other events",
  tasks: "Tasks",
  workHabits: "Work habits",
  personalHabits: "Personal habits",
  focus: "Focus time",
  buffers: "Buffers",
};
const COLORS: Record<Category, string> = {
  oneOnOne: "var(--meeting)",
  groupMeetings: "color-mix(in srgb, var(--meeting) 70%, #000)",
  bookedMeetings: "color-mix(in srgb, var(--meeting) 50%, #fff)",
  soloEvents: "var(--external)",
  tasks: "var(--task)",
  workHabits: "var(--habit)",
  personalHabits: "color-mix(in srgb, var(--habit) 50%, #fff)",
  focus: "var(--focus)",
  buffers: "var(--buffer)",
};
const ORDER = Object.keys(LABELS) as Category[];
const round = (m: number) => duration(Math.round(m));

export function StatsPage() {
  const z = zone();
  const today = utcToLocal(z, Date.now()).date;
  const monday = addDays(today, 1 - weekdayOf(today));
  const picks = {
    "This week": [monday, addDays(monday, 6)],
    "Last week": [addDays(monday, -7), addDays(monday, -1)],
    "Next week": [addDays(monday, 7), addDays(monday, 13)],
    "Last 4 weeks": [addDays(monday, -28), addDays(monday, -1)],
  } as const;
  // ?from=&to= keeps the range across reloads.
  const [range, setRange] = useState<readonly [string, string]>(() => {
    const q = new URLSearchParams(location.search);
    const [f, t] = [q.get("from") ?? "", q.get("to") ?? ""];
    return DATE.test(f) && DATE.test(t) ? [f, t] : picks["This week"];
  });
  const [grouping, setGrouping] = useState<"day" | "week">("day");
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    void api<Stats>("GET", `/api/stats?from=${range[0]}&to=${range[1]}`).then(setStats);
    history.replaceState(null, "", `/stats?from=${range[0]}&to=${range[1]}`);
  }, [range]);

  const groups = (() => {
    if (!stats) return [];
    if (grouping === "day")
      return stats.days.map((d) => ({ label: d.date.slice(5), minutes: d.minutes }));
    const weeks: { label: string; minutes: Record<Category, number> }[] = [];
    stats.days.forEach((d, i) => {
      if (i % 7 === 0)
        weeks.push({ label: `Week of ${d.date.slice(5)}`, minutes: { ...d.minutes } });
      else
        for (const c of ORDER) (weeks.at(-1) as (typeof weeks)[number]).minutes[c] += d.minutes[c];
    });
    return weeks;
  })();
  const max = Math.max(1, ...groups.map((g) => ORDER.reduce((a, c) => a + g.minutes[c], 0)));
  const periods = Math.max(1, groups.length);

  return (
    <div class="page" data-testid="stats-page">
      <h1>Stats</h1>
      <StatsTabs />
      <div class="actions">
        {Object.entries(picks).map(([label, r]) => (
          <button
            type="button"
            key={label}
            aria-pressed={range[0] === r[0] && range[1] === r[1]}
            onClick={() => setRange(r)}
          >
            {label}
          </button>
        ))}
        <label class="inline">
          From
          <input
            type="date"
            aria-label="From"
            value={range[0]}
            onChange={(e) => setRange([e.currentTarget.value, range[1]])}
          />
        </label>
        <label class="inline">
          To
          <input
            type="date"
            aria-label="To"
            value={range[1]}
            onChange={(e) => setRange([range[0], e.currentTarget.value])}
          />
        </label>
        <select
          aria-label="Group by"
          value={grouping}
          onChange={(e) => setGrouping(e.currentTarget.value as "day" | "week")}
        >
          <option value="day">By day</option>
          <option value="week">By week</option>
        </select>
      </div>
      {stats && (
        <>
          <h2>Time breakdown</h2>
          <div class="list" data-testid="breakdown">
            {ORDER.map((c) => (
              <div class="row" key={c}>
                <span>
                  <span class="swatch" style={{ background: COLORS[c] }} /> {LABELS[c]}
                </span>
                <span>
                  <strong data-testid={`stat-${c}`}>{round(stats.totals[c])}</strong>
                  <span class="meta">
                    {" "}
                    · {round(stats.totals[c] / periods)} per {grouping}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <h2>Trend</h2>
          <div class="trend" data-testid="trend">
            {groups.map((g) => (
              <div class="trend-col" key={g.label} title={g.label}>
                <div class="trend-bar">
                  {ORDER.map((c) =>
                    g.minutes[c] > 0 ? (
                      <div
                        key={c}
                        style={{ height: `${(g.minutes[c] / max) * 160}px`, background: COLORS[c] }}
                        title={`${LABELS[c]}: ${round(g.minutes[c])}`}
                      />
                    ) : null,
                  )}
                </div>
                <div class="meta">{g.label}</div>
              </div>
            ))}
          </div>
          <h2>Highlights</h2>
          <div class="list" data-testid="highlights">
            <div class="row">
              <span>Meetings</span>
              <strong data-testid="hl-meetings">{round(stats.highlights.meetingMinutes)}</strong>
            </div>
            <div class="row">
              <span>Meetings outside work hours</span>
              <strong data-testid="hl-outside">
                {round(stats.highlights.meetingMinutesOutsideWorkHours)}
              </strong>
            </div>
            <div class="row">
              <span>Focus time held</span>
              <strong data-testid="hl-focus">{round(stats.highlights.focusMinutes)}</strong>
            </div>
            <div class="row">
              <span>Meetings booked through links</span>
              <strong data-testid="hl-bookings">{stats.highlights.bookings}</strong>
            </div>
          </div>
          <StatsExtras from={range[0]} to={range[1]} />
        </>
      )}
    </div>
  );
}
