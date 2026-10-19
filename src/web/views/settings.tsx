import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { CATEGORIES } from "../../scheduler/categories.ts";
import type { Settings as UserSettings } from "../../server/settings.ts";
import { defaultEventSettings, readEventSettings } from "../../shared/event-settings.ts";
import { api } from "../lib/api.ts";
import { CATEGORY_LABELS, COLORS } from "../lib/categories.ts";
import { hhmm, parseHhmm } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { loadPolicyMarks, PolicyMark, policyMarks } from "../lib/policy-marks.tsx";
import { loadMe, me, planNow } from "../lib/state.ts";
import { BufferEditor } from "./buffer-editor.tsx";
import { FocusOptionsList, MeetingOverloadSection } from "./focus-options.tsx";
import { MeetingSettings } from "./meeting-settings.tsx";
import {
  AlertSettings,
  DeleteHoursSet,
  FocusNotes,
  HoursZoneNote,
  PlacementSetting,
  TravelSettings,
} from "./settings-extra.tsx";
import { WeeklyReportSetting } from "./weekly-report-setting.tsx";

interface HoursSet {
  id: string;
  kind: string;
  name: string;
  weekly: Record<string, [number, number][]>;
}
const FocusRecommendation = lazyComponent(() =>
  import("./team-recommendations.tsx").then((m) => m.FocusRecommendation),
);
const CalendarSettings = lazyComponent(() =>
  import("./calendars.tsx").then((m) => m.CalendarSettings),
);
const MirrorSettings = lazyComponent(() => import("./mirroring.tsx").then((m) => m.MirrorSettings));

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function HoursEditor({
  set,
  onSave,
  children,
}: {
  set: HoursSet;
  onSave: (weekly: HoursSet["weekly"]) => Promise<void>;
  children?: ComponentChildren;
}) {
  const [weekly, setWeekly] = useState(set.weekly);
  const update = (day: string, i: number, which: 0 | 1, value: string) => {
    const ranges = [...(weekly[day] ?? [])];
    const r = [...(ranges[i] ?? [540, 1020])] as [number, number];
    r[which] = value === "24:00" ? 1440 : parseHhmm(value);
    ranges[i] = r;
    setWeekly({ ...weekly, [day]: ranges });
  };
  return (
    <div class="hours" data-testid={`hours-${set.kind}`}>
      <h3>{set.name}</h3>
      {DAY_NAMES.map((n, idx) => {
        const day = String(idx + 1);
        const ranges = weekly[day] ?? [];
        return (
          <div class="hours-day" key={day}>
            <span class="day">{n}</span>
            {ranges.map(([s, e], i) => (
              <span
                key={`${day}-${s}-${i}`}
                class="range"
                data-testid={`range-${set.kind}-${day}-${i}`}
              >
                <input
                  type="time"
                  step={900}
                  value={hhmm(s)}
                  onChange={(ev) => update(day, i, 0, ev.currentTarget.value)}
                />
                –
                <input
                  type="time"
                  step={900}
                  value={e >= 1440 ? "23:59" : hhmm(e)}
                  onChange={(ev) => update(day, i, 1, ev.currentTarget.value)}
                />
                <button
                  type="button"
                  onClick={() => setWeekly({ ...weekly, [day]: ranges.filter((_, j) => j !== i) })}
                >
                  −
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setWeekly({ ...weekly, [day]: [...ranges, [540, 1020]] })}
            >
              +
            </button>
          </div>
        );
      })}
      <button type="button" class="primary" onClick={() => void onSave(weekly)}>
        Save {set.name.toLowerCase()}
      </button>
      {children}
    </div>
  );
}

export function Settings() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [windowLimit, setWindowLimit] = useState<number | null>(null);
  const [hours, setHours] = useState<HoursSet[]>([]);
  const [buffers, setBuffers] = useState<
    {
      id: string;
      title: string;
      side: string;
      minutes_before: number;
      minutes_after: number;
      calendar_scope: string | null;
    }[]
  >([]);
  const [focus, setFocus] = useState<
    { id: string; title: string; weekly_goal_minutes: number; event_settings: string }[]
  >([]);
  // The buffer editor's calendar scope lists the connected calendars.
  const [calendars, setCalendars] = useState<{ id: string; name: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, h, b, f, c] = await Promise.all([
      api<{ settings: UserSettings; windowLimit: number | null }>("GET", "/api/settings"),
      api<{ hours: HoursSet[] }>("GET", "/api/hours"),
      api<{ buffers: typeof buffers }>("GET", "/api/buffers"),
      api<{ focus: typeof focus }>("GET", "/api/focus"),
      api<{ calendars: { id: string; name: string }[] }>("GET", "/api/calendars"),
    ]);
    setSettings(s.settings);
    setWindowLimit(s.windowLimit);
    setHours(h.hours);
    setBuffers(b.buffers);
    setFocus(f.focus);
    setCalendars(c.calendars);
    await loadPolicyMarks();
  }, []);
  useEffect(() => void load(), [load]);
  // The hours preview of item editors links here (planning-hours.md HRS-11).
  const ready = settings !== null;
  useEffect(() => {
    if (ready && new URLSearchParams(location.search).get("section") === "hours")
      document.getElementById("hours")?.scrollIntoView();
  }, [ready]);

  const act = async (fn: () => Promise<unknown>, done = "Saved") => {
    setMessage(null);
    try {
      await fn();
      await planNow();
      await Promise.all([load(), loadMe()]);
      setMessage(done);
    } catch (err) {
      const body = (err as { body?: { message?: string } }).body;
      setMessage(body?.message ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  if (!settings) return null;
  return (
    <div class="page" data-testid="settings-page">
      <h1>Settings</h1>
      {message && (
        <p class="status" data-testid="settings-message">
          {message}
        </p>
      )}

      <section>
        <h2>Scheduling</h2>
        <div class="form">
          <label>
            Plan ahead (weeks)
            <input
              name="schedulingWindowWeeks"
              type="number"
              min={1}
              max={windowLimit ?? 12}
              value={settings.schedulingWindowWeeks}
              onChange={(e) =>
                void act(() =>
                  api("PATCH", "/api/settings", {
                    schedulingWindowWeeks: Number(e.currentTarget.value),
                  }),
                )
              }
            />
          </label>
          {windowLimit !== null && (
            <p class="meta" data-testid="window-limit">
              This server plans at most {windowLimit} {windowLimit === 1 ? "week" : "weeks"} ahead.
            </p>
          )}
          <label>
            Break between tasks and habits
            <select
              name="breakMinutes"
              value={settings.breakMinutes}
              onChange={(e) =>
                void act(() =>
                  api("PATCH", "/api/settings", { breakMinutes: Number(e.currentTarget.value) }),
                )
              }
            >
              {[0, 5, 10, 15, 20, 30].map((m) => (
                <option value={m} key={m}>
                  {m === 0 ? "None" : `${m} minutes`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Urgency
            <select
              name="urgencyMode"
              value={settings.urgencyMode}
              onChange={(e) =>
                void act(() =>
                  api("PATCH", "/api/settings", { urgencyMode: e.currentTarget.value }),
                )
              }
            >
              <option value="priority-only">Priority only</option>
              <option value="due-date">Raise tasks due within 48 hours</option>
              <option value="due-date-and-work">Raise tasks that are short of time</option>
            </select>
          </label>
          <label>
            Time zone
            <input
              name="timeZone"
              defaultValue={me.value?.user.time_zone ?? ""}
              onChange={(e) =>
                void act(() => api("PATCH", "/api/me", { timeZone: e.currentTarget.value }))
              }
            />
          </label>
          <label>
            Planning
            <select
              name="paused"
              value={settings.paused ? "paused" : "on"}
              onChange={(e) =>
                void act(() =>
                  api("PATCH", "/api/settings", { paused: e.currentTarget.value === "paused" }),
                )
              }
            >
              <option value="on">On</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <PlacementSetting settings={settings} act={act} />
        </div>
      </section>

      <AlertSettings settings={settings} act={act} />

      <section id="hours">
        <h2>Hours</h2>
        <HoursZoneNote />
        {hours.map((h) => (
          <HoursEditor
            key={h.id}
            set={h}
            onSave={(weekly) => act(() => api("PUT", `/api/hours/${h.id}`, { weekly }))}
          >
            {h.kind === "custom" && <DeleteHoursSet set={h} sets={hours} act={act} />}
          </HoursEditor>
        ))}
        <form
          class="actions"
          data-testid="custom-hours-form"
          onSubmit={(e) => {
            e.preventDefault();
            const input = (e.currentTarget as HTMLFormElement).elements.namedItem(
              "name",
            ) as HTMLInputElement;
            const name = input.value.trim();
            if (!name) return;
            void act(() =>
              api("POST", "/api/hours", {
                name,
                weekly: {
                  1: [[540, 1020]],
                  2: [[540, 1020]],
                  3: [[540, 1020]],
                  4: [[540, 1020]],
                  5: [[540, 1020]],
                },
              }),
            );
            input.value = "";
          }}
        >
          <input
            name="name"
            placeholder="Name of a new hours set"
            aria-label="New hours set name"
          />
          <button type="submit">+ Custom hours</button>
        </form>
      </section>

      <TravelSettings />

      <CalendarSettings />
      <MirrorSettings />

      <section>
        <h2>Buffers</h2>
        <div class="actions">
          <button
            type="button"
            onClick={() =>
              void act(() =>
                api("POST", "/api/buffers", {
                  title: "Recovery",
                  side: "after",
                  minutesAfter: 15,
                  level: 2,
                  filter: { participants: { op: ">=", value: 2 } },
                }),
              )
            }
          >
            Add 15 min recovery after meetings
          </button>
          <button
            type="button"
            onClick={() =>
              void act(() =>
                api("POST", "/api/buffers", {
                  title: "Prep",
                  side: "before",
                  minutesBefore: 15,
                  level: 3,
                  filter: { participants: { op: ">=", value: 2 } },
                }),
              )
            }
          >
            Add 15 min prep before meetings
          </button>
          <button
            type="button"
            onClick={() =>
              void act(() =>
                api("POST", "/api/buffers", {
                  title: "Travel",
                  side: "both",
                  minutesBefore: 30,
                  minutesAfter: 30,
                  level: 2,
                  filter: { travel: true },
                }),
              )
            }
          >
            Add travel time (30 min)
          </button>
          <button
            type="button"
            onClick={() =>
              void act(() =>
                api("POST", "/api/buffers", {
                  title: "Airport",
                  side: "both",
                  minutesBefore: 120,
                  minutesAfter: 60,
                  level: 1,
                  filter: { flight: true },
                }),
              )
            }
          >
            Add airport time (2 h before, 1 h after)
          </button>
        </div>
        <BufferEditor calendars={calendars} onSaved={load} />
        <div class="list" data-testid="buffer-list">
          {buffers.map((b) => (
            <div class="row" key={b.id} data-buffer-title={b.title}>
              <span>
                {b.title} ·{" "}
                {b.side === "before"
                  ? `${b.minutes_before} min before`
                  : `${b.minutes_after} min after`}{" "}
                ·{" "}
                {b.calendar_scope
                  ? `${calendars.find((c) => c.id === b.calendar_scope)?.name ?? "one calendar"} only`
                  : "all calendars"}{" "}
                <PolicyMark id={b.id} />
              </span>
              {!policyMarks.value[b.id] && (
                <button
                  type="button"
                  class="danger"
                  onClick={() => void act(() => api("DELETE", `/api/buffers/${b.id}`))}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Colors</h2>
        <form
          class="form"
          data-testid="color-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget as HTMLFormElement);
            void act(() =>
              api("PATCH", "/api/settings", {
                colorScope: f.get("colorScope"),
                categoryColors: Object.fromEntries(
                  CATEGORIES.map((k) => [k, String(f.get(`color-${k}`))]),
                ),
              }),
            );
          }}
        >
          <label class="wide">
            Paint
            <select name="colorScope" aria-label="Paint">
              <option value="managed_only" selected={settings.colorScope === "managed_only"}>
                Only events Tempoloom manages
              </option>
              <option value="all_events" selected={settings.colorScope === "all_events"}>
                All events on my calendars
              </option>
            </select>
          </label>
          {CATEGORIES.map((k) => (
            <label key={k}>
              {CATEGORY_LABELS[k]}
              <select name={`color-${k}`} aria-label={CATEGORY_LABELS[k]}>
                <option value="calendar_default">Calendar color</option>
                {COLORS.map((c) => (
                  <option value={c.id} key={c.id} selected={settings.categoryColors[k] === c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button type="submit" class="primary">
            Save colors
          </button>
          <p class="meta wide">Outlook calendars may not show these colors.</p>
        </form>
      </section>

      <section>
        <h2>Focus time</h2>
        <FocusRecommendation onDone={() => act(async () => {})} />
        {focus.length === 0 ? (
          <button
            type="button"
            onClick={() =>
              void act(() =>
                api("POST", "/api/focus", {
                  weeklyGoalMinutes: 600,
                  dailyMinMinutes: 60,
                  dailyMaxMinutes: 240,
                  minBlockMinutes: 60,
                  maxBlockMinutes: 180,
                }),
              )
            }
          >
            Protect 10 hours of focus time per week
          </button>
        ) : (
          focus.map((f) => (
            <div class="row" key={f.id} data-focus-title={f.title}>
              <span>
                {f.title} · {f.weekly_goal_minutes / 60} h per week <PolicyMark id={f.id} />
              </span>
              <FocusNotes
                id={f.id}
                notes={
                  readEventSettings(f.event_settings, defaultEventSettings("focus_time"))
                    .description
                }
                act={act}
              />
              {!policyMarks.value[f.id] && (
                <button
                  type="button"
                  class="danger"
                  onClick={() => void act(() => api("DELETE", `/api/focus/${f.id}`))}
                >
                  Delete
                </button>
              )}
            </div>
          ))
        )}
        {focus.length > 0 && <FocusOptionsList key={focus.map((f) => f.id).join(",")} />}
      </section>

      <MeetingOverloadSection />
      <MeetingSettings />
      <WeeklyReportSetting />
    </div>
  );
}
