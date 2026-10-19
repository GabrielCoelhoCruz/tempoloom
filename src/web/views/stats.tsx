import { useEffect, useRef, useState } from "preact/hooks";
import { addDays, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { zone } from "../lib/state.ts";
import { StatsTabs } from "./stats-tabs.tsx";

const StatsExtras = lazyComponent<{ from: string; to: string; base: Base }>(() =>
  import("./stats-extras.tsx").then((m) => m.StatsExtras),
);
type Base = import("./stats-extras.tsx").BaseStats;
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
  // The newest choice: a quick second edit can come before the re-render that
  // carries the first one. The address is written here, not in an effect,
  // because effects run after paint and a reload can come before them.
  const latest = useRef(range);
  const choose = (next: (r: readonly [string, string]) => readonly [string, string]) => {
    const r = next(latest.current);
    latest.current = r;
    history.replaceState(null, "", `/stats?from=${r[0]}&to=${r[1]}`);
    setRange(r);
  };
  const [grouping, setGrouping] = useState<"day" | "week">("day");
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    // An older range's answer can arrive after a newer one; drop it.
    let current = true;
    void api<Stats>("GET", `/api/stats?from=${range[0]}&to=${range[1]}`).then((s) => {
      if (current) setStats(s);
    });
    return () => {
      current = false;
    };
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
            onClick={() => choose(() => r)}
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
            onChange={(e) => {
              const from = e.currentTarget.value;
              choose((r) => [from, r[1]]);
            }}
          />
        </label>
        <label class="inline">
          To
          <input
            type="date"
            aria-label="To"
            value={range[1]}
            onChange={(e) => {
              const to = e.currentTarget.value;
              choose((r) => [r[0], to]);
            }}
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
          <StatsExtras
            from={range[0]}
            to={range[1]}
            base={{ ...stats.highlights, personalHabits: stats.totals.personalHabits }}
          />
        </>
      )}
    </div>
  );
}
