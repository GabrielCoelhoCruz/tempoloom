// Parts of the planner that load on demand: actions on one event
// (planning-planner.md PLN-11), the tasks of the running habit or focus event
// (planning-next-up.md NXT-42), and weekly focus progress (focus-time.md Outputs).
import { useCallback, useEffect, useState } from "preact/hooks";
import type { PlannerEvent } from "../../server/api/planner.ts";
import { utcToLocal } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { fromLocalInput, hhmm, toLocalInput } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { navigate, onLinkClick } from "../lib/router.ts";
import { zone } from "../lib/state.ts";
import { type SearchTask, SearchTaskList, TaskSearchPicker } from "./task-search-picker.tsx";

interface Actions {
  kind: string;
  series?: { eligible: boolean; reason: string | null } | null;
  sourceId?: string;
  date?: string | null;
  ended?: boolean;
  done?: boolean;
  search?: { kind: string; id: string; searchId: string | null } | null;
}

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
  useEffect(() => {
    let live = true;
    void api<Actions>("GET", `/api/event-actions/${encodeURIComponent(event.id)}`).then((a) => {
      if (!live) return;
      setInfo(a);
      setSearchId(a.search?.searchId ?? null);
    });
    return () => {
      live = false;
    };
  }, [event.id]);
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
      {info.search && (
        <div data-testid="event-task-search">
          <TaskSearchPicker value={searchId} onChange={(id) => void assign(id)} />
          {searchId && <SearchTaskList tasks={tasks} name={name} />}
        </div>
      )}
    </div>
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
  const load = useCallback(async () => {
    setProgress(
      (await api<{ progress: Progress[] }>("GET", `/api/focus/progress?week=${week}`)).progress,
    );
  }, [week]);
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
export function LogWork({ start, onClose }: { start: number; onClose: (saved: boolean) => void }) {
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
        <input type="number" name="minutes" min={1} max={1440} required defaultValue="30" />
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
