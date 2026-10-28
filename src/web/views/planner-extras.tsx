// Parts of the planner that load on demand: actions on one event
// (planning-planner.md PLN-11), the tasks of the running habit or focus event
// (planning-next-up.md NXT-42), and weekly focus progress (focus-time.md Outputs).
import { useCallback, useEffect, useState } from "preact/hooks";
import type { ReportEntry } from "../../scheduler/model.ts";
import type { PlannerEvent } from "../../server/api/planner.ts";
import { utcToLocal } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { fromLocalInput, hhmm, timeText, toLocalInput } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { useNewest } from "../lib/newest.ts";
import { navigate, onLinkClick } from "../lib/router.ts";
import { zone } from "../lib/state.ts";
import { type SearchTask, SearchTaskList, TaskSearchPicker } from "./task-search-picker.tsx";
import "./parts.css";

interface Actions {
  kind: string;
  series?: { eligible: boolean; reason: string | null } | null;
  sourceId?: string;
  date?: string | null;
  /** The planning zone (a travel zone on its dates): the API reads chosen times in it. */
  zone?: string;
  ended?: boolean;
  started?: boolean;
  done?: boolean;
  search?: { kind: string; id: string; searchId: string | null } | null;
}

/** Minimum delays of the focus reschedule action (focus-time.md rule 22). */
const DELAYS: [number, string][] = [
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "1 hour"],
  [120, "2 hours"],
  [180, "3 hours"],
  [240, "4 hours"],
  [1440, "1 day"],
];

function useSearchTasks(searchId: string | null) {
  const [tasks, setTasks] = useState<SearchTask[]>([]);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!searchId) {
      setTasks([]);
      return;
    }
    let live = true;
    void Promise.all([
      api<{ tasks: SearchTask[] }>("GET", `/api/task-searches/${searchId}/tasks`),
      api<{ searches: { id: string; name: string }[] }>("GET", "/api/task-searches"),
    ]).then(([t, s]) => {
      if (!live) return;
      setTasks(t.tasks);
      setName(s.searches.find((x) => x.id === searchId)?.name ?? "");
    });
    return () => {
      live = false;
    };
  }, [searchId]);
  return { tasks, name };
}

/** Event actions in the details panel; `run` changes the plan, `close` closes the panel. */
export function EventActions({
  event,
  zone,
  run,
  close,
}: {
  event: PlannerEvent;
  zone: string;
  run: (fn: () => Promise<unknown>) => void;
  close: () => void;
}) {
  const [info, setInfo] = useState<Actions | null>(null);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [time, setTime] = useState(() => hhmm(utcToLocal(zone, event.start).minuteOfDay));
  const [delay, setDelay] = useState(60);
  useEffect(() => {
    let live = true;
    void api<Actions>("GET", `/api/event-actions/${encodeURIComponent(event.id)}`).then((a) => {
      if (!live) return;
      setInfo(a);
      setSearchId(a.search?.searchId ?? null);
      if (a.zone) setTime(hhmm(utcToLocal(a.zone, event.start).minuteOfDay));
    });
    return () => {
      live = false;
    };
  }, [event.id, event.start]);
  const { tasks, name } = useSearchTasks(searchId);
  if (!info) return null;

  const assign = async (id: string | null) => {
    const target = info.search;
    if (!target) return;
    await api("PUT", "/api/task-searches/assign", {
      kind: target.kind,
      id: target.id,
      searchId: id,
    });
    setSearchId(id);
  };

  return (
    <div class="event-actions" data-testid="event-actions">
      {info.kind === "external" && info.series?.eligible && (
        <button
          type="button"
          onClick={() => navigate(`/habits?from=${encodeURIComponent(event.id)}`)}
        >
          Make a habit
        </button>
      )}
      {info.kind === "external" && info.series && !info.series.eligible && (
        <p class="status">
          This series has other guests: make it a flexible meeting instead.{" "}
          <a href="/meetings" onClick={onLinkClick}>
            Flexible meetings
          </a>
        </p>
      )}
      {info.kind === "habit" && info.done && (
        <p class="status" data-testid="occurrence-done">
          Done
        </p>
      )}
      {info.kind === "habit" && info.sourceId && (
        <button type="button" onClick={() => navigate(`/habits?edit=${info.sourceId}`)}>
          Edit habit
        </button>
      )}
      {info.kind === "habit" && !info.ended && info.sourceId && info.date && (
        <form
          class="inline"
          data-testid="reschedule-form"
          onSubmit={(e) => {
            e.preventDefault();
            const id = info.sourceId;
            const date = info.date;
            close();
            run(() => api("POST", `/api/habits/${id}/reschedule`, { date, time }));
          }}
        >
          <label>
            Reschedule to
            <input
              type="time"
              step={900}
              required
              value={time}
              onInput={(e) => setTime(e.currentTarget.value)}
            />
          </label>
          <button type="submit">Reschedule</button>
        </form>
      )}
      {info.kind === "focus" && !info.started && (
        <form
          class="inline"
          data-testid="focus-reschedule-form"
          onSubmit={(e) => {
            e.preventDefault();
            close();
            run(() =>
              api("POST", `/api/focus/events/${encodeURIComponent(event.id)}/reschedule`, {
                delayMinutes: delay,
              }),
            );
          }}
        >
          <label>
            At least
            <select value={delay} onChange={(e) => setDelay(Number(e.currentTarget.value))}>
              {DELAYS.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span class="meta">from now</span>
          <button type="submit">Reschedule</button>
        </form>
      )}
      {info.kind === "habit" && !info.ended && info.sourceId && info.date && (
        <SnoozeForm
          start={event.start}
          zone={info.zone ?? zone}
          snooze={(time) => {
            const id = info.sourceId;
            const date = info.date;
            close();
            run(() => api("POST", `/api/habits/${id}/snooze`, { date, time }));
          }}
        />
      )}
      {info.search && (
        <div data-testid="event-task-search">
          <TaskSearchPicker value={searchId} onChange={(id) => void assign(id)} />
          {searchId && <SearchTaskList tasks={tasks} name={name} />}
        </div>
      )}
    </div>
  );
}

const SNOOZES = [15, 30, 60, 120];

/**
 * Habits rule 31: the occurrence goes to the first legal start at or after
 * the "not before" time, on the same day. Tempoloom decision: the quick
 * choices count from the later of the occurrence's start and now, up to the
 * next 15 minutes; a choice past the end of the day is not offered, and a
 * typed time must be after that base (an earlier time is not a snooze). A
 * snooze also moves an occurrence that has started.
 */
function SnoozeForm({
  start,
  zone,
  snooze,
}: {
  start: number;
  zone: string;
  snooze: (time: string) => void;
}) {
  const base = utcToLocal(zone, Math.max(start, Date.now())).minuteOfDay;
  const after = (minutes: number) => {
    const t = Math.ceil((base + minutes) / 15) * 15;
    return t < 24 * 60 ? hhmm(t) : null;
  };
  const [time, setTime] = useState(() => after(30) ?? "");
  const [error, setError] = useState("");
  return (
    <form
      class="inline"
      data-testid="snooze-form"
      onSubmit={(e) => {
        e.preventDefault();
        const [h, m] = time.split(":").map(Number) as [number, number];
        if (h * 60 + m <= base) {
          setError(`Pick a time after ${timeText(base)}`);
          return;
        }
        snooze(time);
      }}
    >
      {SNOOZES.map((m) => {
        const t = after(m);
        return (
          <button
            type="button"
            key={m}
            disabled={t === null}
            title={t ?? "Past the end of the day"}
            onClick={() => {
              if (t) setTime(t);
              setError("");
            }}
          >
            +{m < 60 ? `${m} min` : `${m / 60} h`}
          </button>
        );
      })}
      <label>
        Not before
        <input
          type="time"
          step={900}
          required
          value={time}
          onInput={(e) => {
            setTime(e.currentTarget.value);
            setError("");
          }}
        />
      </label>
      <button type="submit">Snooze</button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

interface Current {
  title: string;
  search: { id: string; name: string };
  tasks: SearchTask[];
}

/** NXT-42: while a habit or focus event with a task search runs, its tasks. */
export function CurrentTasks() {
  const [current, setCurrent] = useState<Current | null>(null);
  const load = useCallback(async () => {
    setCurrent(
      (await api<{ current: Current | null }>("GET", "/api/task-searches/current")).current,
    );
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  useLive(load);
  if (!current) return null;
  return (
    <section class="current-tasks" data-testid="current-tasks">
      <h2>Now: {current.title}</h2>
      <div class="meta">Tasks for this time ({current.search.name})</div>
      <SearchTaskList tasks={current.tasks} name={current.search.name} />
    </section>
  );
}

interface Progress {
  id: string;
  title: string;
  goalMinutes: number;
  countedMinutes: number;
  missingMinutes: number;
}

const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;

/** Weekly focus progress and the "goal not reached" notice (focus-time.md rule 35). */
export function FocusProgress({ week }: { week: string }) {
  const [progress, setProgress] = useState<Progress[]>([]);
  // The URL changes with the week: only the newest load may draw.
  const newest = useNewest();
  const load = useCallback(async () => {
    const isNewest = newest();
    const r = await api<{ progress: Progress[] }>("GET", `/api/focus/progress?week=${week}`);
    if (isNewest()) setProgress(r.progress);
  }, [newest, week]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  useLive(load);
  if (progress.length === 0) return null;
  return (
    <div class="focus-progress" data-testid="focus-progress">
      {progress.map((p) => (
        <div key={p.id} data-focus-goal={p.title}>
          {p.title}: {hours(p.countedMinutes)} of {hours(p.goalMinutes)} this week.
          {p.missingMinutes > 0 && (
            <strong class="warning"> Goal not reached: {hours(p.missingMinutes)} missing.</strong>
          )}
        </div>
      ))}
    </div>
  );
}

interface WorkItem {
  value: string;
  label: string;
}

/**
 * Log work (planning-task-progress.md PRG-20 to PRG-22, habits-automation.md
 * rule 32): minutes on a task or a habit from a past start time. Tempoloom
 * writes a past event for it, and a task's remaining work goes down.
 */
export function LogWork({
  start,
  minutes = 30,
  onClose,
}: {
  start: number;
  minutes?: number | undefined;
  onClose: (saved: boolean) => void;
}) {
  const z = zone();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([
      api<{ tasks: { id: string; title: string }[] }>("GET", "/api/tasks?status=open"),
      api<{ habits: { id: string; title: string }[] }>("GET", "/api/habits"),
    ]).then(([t, h]) =>
      setItems([
        ...t.tasks.map((x) => ({ value: `task:${x.id}`, label: x.title })),
        ...h.habits.map((x) => ({ value: `habit:${x.id}`, label: `${x.title} (habit)` })),
      ]),
    );
  }, []);
  return (
    <form
      class="form log-work"
      data-testid="log-work"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        const [kind, itemId] = String(f.get("item")).split(":");
        setError(null);
        void api("POST", "/api/log-work", {
          kind,
          itemId,
          start: fromLocalInput(z, String(f.get("start"))),
          minutes: Number(f.get("minutes")),
        })
          .then(() => onClose(true))
          .catch((err) =>
            setError(
              (err as { body?: { message?: string } }).body?.message ??
                "That did not work. Try again.",
            ),
          );
      }}
    >
      <label>
        Start
        <input type="datetime-local" name="start" required defaultValue={toLocalInput(z, start)} />
      </label>
      <label>
        Work on
        <select name="item" required>
          {items.map((i) => (
            <option value={i.value} key={i.value}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Minutes
        <input
          type="number"
          name="minutes"
          min={1}
          max={1440}
          required
          defaultValue={String(minutes)}
        />
      </label>
      <button type="submit" class="primary">
        Log work
      </button>
      <button type="button" onClick={() => onClose(false)}>
        Cancel
      </button>
      {error && (
        <p class="error" data-testid="log-error">
          {error}
        </p>
      )}
    </form>
  );
}

const AWAY = "time away (all-day or out-of-office events) covers all its hours";
const REASONS: Record<string, string> = {
  "outside-window": "starts after the scheduling window",
  "no-hours": "its hours have no time in this period",
  "too-long-for-hours": "longer than any range of its hours",
  away: AWAY,
  // Reports stored before the rename still say "all-day-block".
  "all-day-block": AWAY,
  "reserved-word": "an event with a reserved word exists that day",
  "no-space-fixed": "no free time between your meetings",
  "no-space-priority": "higher-priority items use the free time",
  "after-due": "part of the work ends after the due date",
};

/** The scheduler's report: the items it could not place, with the reasons. */
export function Report({ report }: { report: ReportEntry[] }) {
  if (report.length === 0) return null;
  return (
    <details class="issues" data-testid="issues">
      <summary>{report.length} items need attention</summary>
      <ul>
        {report.slice(0, 50).map((r) => (
          <li key={r.demandKey}>
            <strong>{r.itemKind}</strong> {r.demandKey.split(":").slice(2).join(" ")} — {r.status}:{" "}
            {REASONS[r.reason] ?? r.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
