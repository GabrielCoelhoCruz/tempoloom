// Stats by category (docs/specs/analytics-personal-stats.md rules 1, 4, 6-8,
// 12-13): deep and shallow work, breaks, travel and time away, weekday panels,
// people met, insights, and calendar facts (analytics-weekly-reports.md rule 7).
import { useEffect, useState } from "preact/hooks";
import { type Fact, factText } from "../../shared/facts.ts";
import { api } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { useNewest } from "../lib/newest.ts";
import "./pages.css";

interface Insights {
  categories: Record<string, number>;
  weekdays: { weekday: number; name: string; solo: number; meetings: number; workload: number }[];
  mostProductive: string | null;
  busiestMeetingDay: { name: string; minutes: number } | null;
  lightestMeetingDay: { name: string; minutes: number } | null;
  people: { email: string; minutes: number }[];
  highlights: { breaks: number; travelBuffers: number };
  insights: {
    meetings: number;
    solo: number;
    manyMeetingDays: { date: string; name: string; meetings: number; minutes: number }[];
    shortFocus: { pieces: number; minutes: number };
    repeats: { title: string; count: number }[];
  };
  facts: Fact[];
  plannedActual: { days: number; byKind: Record<string, { planned: number; actual: number }> };
}

const KINDS: Record<string, string> = {
  task: "Tasks",
  habit: "Habits",
  focus: "Focus time",
  buffer: "Buffers",
  meeting: "Flexible meetings",
};

const LABELS: [string, string][] = [
  ["one_on_one", "One-on-one meetings"],
  ["team_meeting", "Team meetings"],
  ["external_meeting", "External meetings"],
  ["deep_work", "Deep work (2 hours or more)"],
  ["shallow_work", "Shallow work"],
  ["personal", "Personal"],
  ["travel", "Travel"],
  ["breaks", "Breaks"],
  ["vacation", "Time away"],
  ["personal_commitment", "Personal commitments"],
  ["free", "Free work time"],
];
const h = (m: number) => duration(Math.round(m));

/** Figures of the main stats answer that the highlights and balance panels show. */
export interface BaseStats {
  meetingMinutes: number;
  meetingMinutesOutsideWorkHours: number;
  focusMinutes: number;
  bookings: number;
  personalHabits: number;
}

export function StatsExtras({ from, to, base }: { from: string; to: string; base: BaseStats }) {
  const [data, setData] = useState<Insights | null>(null);
  const newest = useNewest();
  useEffect(() => {
    const isNewest = newest();
    void api<Insights>("GET", `/api/stats/insights?from=${from}&to=${to}`).then(
      (d) => {
        // Only the answer for the newest range counts.
        if (isNewest()) setData(d);
      },
      () => {
        if (isNewest()) setData(null);
      },
    );
  }, [newest, from, to]);
  if (!data) return null;
  const maxSolo = Math.max(1, ...data.weekdays.map((w) => w.solo));
  const i = data.insights;
  return (
    <>
      <h2>Time by category</h2>
      <div class="list" data-testid="cat-breakdown">
        {LABELS.map(([key, label]) => (
          <div class="row" key={key}>
            <span>{label}</span>
            <strong data-testid={`cat-${key}`}>{h(data.categories[key] ?? 0)}</strong>
          </div>
        ))}
      </div>

      <h2>Focus</h2>
      <div class="list" data-testid="focus-panel">
        <div class="row">
          <span>
            Deep work {h(data.categories.deep_work ?? 0)} · shallow work{" "}
            {h(data.categories.shallow_work ?? 0)}
          </span>
          <strong>
            {data.mostProductive
              ? `Most productive day: ${data.mostProductive}`
              : "No solo work in this range"}
          </strong>
        </div>
        <div class="heat">
          {data.weekdays.map((w) => (
            <div
              key={w.weekday}
              class="heat-cell"
              data-testid={`weekday-${w.weekday}`}
              title={`${w.name}: ${h(w.solo)} of solo work on average`}
              style={{
                background: `color-mix(in srgb, var(--cat-focus) ${Math.round((w.solo / maxSolo) * 100)}%, var(--bg-surface))`,
              }}
            >
              <span>{w.name.slice(0, 3)}</span>
              <span class="meta">{h(w.solo)}</span>
            </div>
          ))}
        </div>
      </div>

      <h2>Meeting days</h2>
      <div class="list" data-testid="meeting-days">
        <div class="row">
          <span>
            {data.busiestMeetingDay
              ? `Busiest meeting day: ${data.busiestMeetingDay.name} (${h(data.busiestMeetingDay.minutes)})`
              : "No meetings in this range"}
          </span>
          {data.lightestMeetingDay && (
            <span>
              Lightest meeting day: {data.lightestMeetingDay.name} (
              {h(data.lightestMeetingDay.minutes)})
            </span>
          )}
        </div>
      </div>

      <h2>People met</h2>
      <div class="list" data-testid="people-met">
        {data.people.length === 0 && <p class="status">No meetings with other people.</p>}
        {data.people.map((p) => (
          <div class="row" key={p.email} data-testid="person">
            <span>{p.email}</span>
            <strong>{h(p.minutes)}</strong>
          </div>
        ))}
      </div>

      <h2>Highlights</h2>
      <div class="list" data-testid="highlights">
        <div class="row">
          <span>Meetings</span>
          <strong data-testid="hl-meetings">{h(base.meetingMinutes)}</strong>
        </div>
        <div class="row">
          <span>Focus time held</span>
          <strong data-testid="hl-focus">{h(base.focusMinutes)}</strong>
        </div>
        <div class="row">
          <span>Meetings booked through links</span>
          <strong data-testid="hl-bookings">{base.bookings}</strong>
        </div>
        <div class="row">
          <span>Breaks between meetings</span>
          <strong data-testid="hl-breaks">{h(data.highlights.breaks)}</strong>
        </div>
        <div class="row">
          <span>Travel buffers</span>
          <strong data-testid="hl-travel">{h(data.highlights.travelBuffers)}</strong>
        </div>
      </div>

      <h2>Work-life balance</h2>
      <div class="list" data-testid="work-life-balance">
        <div class="row">
          <span>Personal habits</span>
          <strong data-testid="wl-personal-habits">{h(base.personalHabits)}</strong>
        </div>
        <div class="row">
          <span>Meetings outside work hours</span>
          <strong data-testid="hl-outside">{h(base.meetingMinutesOutsideWorkHours)}</strong>
        </div>
        <div class="row">
          <span>Time away</span>
          <strong data-testid="wl-time-away">{h(data.categories.vacation ?? 0)}</strong>
        </div>
      </div>

      <h2>Insights</h2>
      <ul class="list" data-testid="insights">
        <li>
          Meetings {h(i.meetings)} · solo work {h(i.solo)}
        </li>
        <li>
          Workload by weekday:{" "}
          {data.weekdays.map((w) => `${w.name.slice(0, 3)} ${h(w.workload)}`).join(" · ")}
        </li>
        <li>
          Days with many meetings:{" "}
          {i.manyMeetingDays.length === 0
            ? "none"
            : i.manyMeetingDays.map((d) => `${d.name} (${d.meetings} meetings)`).join(", ")}
        </li>
        <li>
          Focus time in short pieces: {h(i.shortFocus.minutes)} in {i.shortFocus.pieces} piece
          {i.shortFocus.pieces === 1 ? "" : "s"} shorter than 2 hours
        </li>
        <li>
          Repeat events:{" "}
          {i.repeats.length === 0
            ? "none"
            : i.repeats.map((r) => `${r.title} (${r.count} times)`).join(", ")}
        </li>
      </ul>

      <h2>Planned versus actual</h2>
      <div class="list" data-testid="planned-actual">
        {data.plannedActual.days === 0 ? (
          <p class="status">No day of this range has ended yet.</p>
        ) : (
          <>
            <p class="status">
              Planned: what was on your calendar when each day began. Actual: what stayed. Over{" "}
              {data.plannedActual.days} ended day{data.plannedActual.days === 1 ? "" : "s"}.
            </p>
            {Object.entries(data.plannedActual.byKind).map(([kind, v]) => (
              <div class="row" key={kind}>
                <span>{KINDS[kind] ?? kind}</span>
                <span>
                  planned {h(v.planned)} · actual {h(v.actual)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <h2>Calendar facts</h2>
      <ul class="list" data-testid="calendar-facts">
        {data.facts.length === 0 && <li>No facts for this range.</li>}
        {data.facts.map((f) => (
          <li key={f.kind}>{factText(f)}</li>
        ))}
      </ul>
    </>
  );
}
