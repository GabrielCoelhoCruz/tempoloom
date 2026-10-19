import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { COLORS } from "../lib/categories.ts";
import { duration, formatWhen, fromLocalInput, toLocalInput } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { LEVEL_NAMES, me, planNow, zone } from "../lib/state.ts";
import { Select } from "./event-settings.tsx";
import { type HoursChoice, HoursField } from "./hours-field.tsx";

const TimerDialog = lazyComponent<{ onClose: () => void }>(() =>
  import("./timer-dialog.tsx").then((m) => m.TimerDialog),
);

interface Task {
  id: string;
  title: string;
  level: number;
  total_minutes: number;
  due_at: number | null;
  next_up_rank: number | null;
  state: string;
  scheduledMinutes: number;
  remainingMinutes: number;
  issue: { status: string; reason: string } | null;
}

const AWAY = "time away (all-day or out-of-office events) covers all its hours";
const REASONS: Record<string, string> = {
  "outside-window": "starts after the planning window",
  "no-hours": "no hours in this period",
  "too-long-for-hours": "a chunk is longer than any range of its hours",
  away: AWAY,
  // Reports stored before the rename still say "all-day-block".
  "all-day-block": AWAY,
  "no-space-fixed": "no free time",
  "no-space-priority": "higher priorities use the free time",
  "after-due": "part ends after the due date",
};

const errorText = (err: unknown) => {
  const body = (err as { body?: { issues?: { message: string }[]; message?: string } }).body;
  return (
    body?.issues?.[0]?.message ??
    body?.message ??
    (err instanceof Error ? err.message : String(err))
  );
};

/**
 * The task creation form, on the tasks page and in the New task dialog
 * (planning-tasks.md TSK-1 to TSK-6). `onSaved` gets the new task's title.
 */
export function TaskForm({
  onSaved,
  children,
}: {
  onSaved: (title: string) => unknown;
  children?: ComponentChildren;
}) {
  const z = zone();
  const d = me.value?.settings.taskDefaults;
  const [hours, setHours] = useState<HoursChoice[]>([]);
  const [split, setSplit] = useState(d?.splitUp ?? true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ hours: HoursChoice[] }>("GET", "/api/hours").then((h) => setHours(h.hours));
  }, []);

  const create = (e: Event) => {
    e.preventDefault();
    const formEl = e.currentTarget as HTMLFormElement;
    const f = new FormData(formEl);
    const text = (k: string) => String(f.get(k) ?? "");
    const num = (k: string) => Number(f.get(k));
    setError(null);
    void (async () => {
      await api("POST", "/api/tasks", {
        title: text("title"),
        ...(text("notes") ? { notes: text("notes") } : {}),
        minutes: num("minutes"),
        level: num("level"),
        splitUp: split,
        ...(split ? { minChunkMinutes: num("minChunk"), maxChunkMinutes: num("maxChunk") } : {}),
        dueAt: text("due") ? fromLocalInput(z, text("due")) : null,
        ...(text("startAfter") ? { startAfter: fromLocalInput(z, text("startAfter")) } : {}),
        ...(text("hoursSetId") ? { hoursSetId: text("hoursSetId") } : {}),
        nextUp: f.get("nextUp") === "on",
        color: text("taskColor"),
      });
      await planNow();
      const title = formEl.elements.namedItem("title") as HTMLInputElement | null;
      if (title) title.value = "";
      await onSaved(text("title"));
    })().catch((err) => setError(errorText(err)));
  };

  return (
    <>
      <form class="form" onSubmit={create} data-testid="task-form">
        <label class="wide">
          Title
          <input name="title" required maxLength={255} />
        </label>
        <label>
          Duration (minutes)
          <input
            name="minutes"
            type="number"
            min={15}
            step={15}
            defaultValue={String(d?.minutes ?? 60)}
          />
        </label>
        <label>
          Priority
          <select name="level">
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l} selected={l === (d?.level ?? 2)}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due
          <input
            name="due"
            type="datetime-local"
            defaultValue={
              d?.dueInDays == null ? "" : toLocalInput(z, Date.now() + d.dueInDays * 86_400_000)
            }
          />
        </label>
        <label>
          Start after
          <input name="startAfter" type="datetime-local" />
        </label>
        <HoursField sets={hours} allowItem={false} />
        <label>
          Split into chunks
          <select
            name="splitUp"
            value={split ? "yes" : "no"}
            onChange={(e) => setSplit(e.currentTarget.value === "yes")}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        {split && (
          <>
            <label>
              Shortest chunk
              <input
                name="minChunk"
                type="number"
                min={15}
                step={15}
                defaultValue={String(d?.minChunkMinutes ?? 30)}
              />
            </label>
            <label>
              Longest chunk
              <input
                name="maxChunk"
                type="number"
                min={15}
                step={15}
                defaultValue={String(d?.maxChunkMinutes ?? 120)}
              />
            </label>
          </>
        )}
        <label class="inline">
          <input name="nextUp" type="checkbox" />
          Next up (work on it first)
        </label>
        <label class="wide">
          Notes
          <textarea name="notes" rows={2} />
        </label>
        <Select
          id="taskColor"
          label="Color"
          initial="category"
          options={[
            ["category", "Category color"],
            ["calendar_default", "Calendar color"],
            ...COLORS.map((c): [string, string] => [c.id, c.name]),
          ]}
        />
        <button type="submit" class="primary">
          Add task
        </button>
        {children}
      </form>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

interface Timer {
  kind: string;
  itemId: string;
}

export function Tasks() {
  const z = zone();
  const [filter, setFilter] = useState<"open" | "done">("open");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [timer, setTimer] = useState<Timer | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [t, tm] = await Promise.all([
      api<{ tasks: Task[] }>("GET", `/api/tasks?status=${filter}`),
      api<{ timer: Timer | null }>("GET", "/api/timer"),
    ]);
    setTasks(t.tasks);
    setTimer(tm.timer);
  }, [filter]);
  useEffect(() => void load(), [load]);
  useLive(load);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div class="page" data-testid="tasks-page">
      <h1>Tasks</h1>
      <TaskForm onSaved={load} />
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {stopping && (
        <TimerDialog
          onClose={() => {
            setStopping(false);
            void load();
          }}
        />
      )}
      <div class="toolbar" style={{ padding: "0 0 8px", border: 0 }}>
        <button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
          Open
        </button>
        <button type="button" aria-pressed={filter === "done"} onClick={() => setFilter("done")}>
          Done
        </button>
      </div>
      <div class="list" data-testid="task-list">
        {tasks.map((t) => (
          <div class="row" key={t.id} data-testid="task-row" data-task-title={t.title}>
            <div>
              <div>
                {t.title}
                {t.next_up_rank !== null && <span class="badge"> next up</span>}
              </div>
              <div class="meta">
                <span data-testid="task-level">{LEVEL_NAMES[t.level]}</span> ·{" "}
                {duration(t.total_minutes)}
                {t.due_at ? (
                  <>
                    {" "}
                    · due <span data-testid="task-due">{formatWhen(z, t.due_at)}</span>
                  </>
                ) : (
                  ""
                )}{" "}
                · <span data-testid="task-state">{t.state}</span>
                {t.scheduledMinutes > 0 ? ` · ${duration(t.scheduledMinutes)} planned` : ""}
                {t.state !== "done" && (
                  <>
                    {" "}
                    · <span data-testid="task-left">{duration(t.remainingMinutes)} left</span>
                  </>
                )}
                {t.issue && (
                  <span class="badge risk" data-testid="task-issue">
                    {" "}
                    {REASONS[t.issue.reason] ?? t.issue.reason}
                  </span>
                )}
              </div>
            </div>
            <div class="actions">
              {filter === "open" &&
                (timer?.kind === "task" && timer.itemId === t.id ? (
                  <>
                    <span class="badge" data-testid="timer-running">
                      Timer running
                    </span>
                    <button type="button" onClick={() => setStopping(true)}>
                      Stop
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={timer !== null}
                    onClick={() =>
                      void act(() => api("POST", "/api/timer", { kind: "task", itemId: t.id }))
                    }
                  >
                    Start timer
                  </button>
                ))}
              {filter === "open" && (
                <button
                  type="button"
                  onClick={() => void act(() => api("POST", `/api/tasks/${t.id}/done`))}
                >
                  Done
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void act(() => api("POST", `/api/tasks/${t.id}/add-time`, { minutes: 30 }))
                }
              >
                +30 min
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => void act(() => api("DELETE", `/api/tasks/${t.id}`))}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {tasks.length === 0 && <p class="status">No {filter} tasks.</p>}
      </div>
    </div>
  );
}
