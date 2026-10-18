import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { duration, formatWhen, fromLocalInput, toLocalInput } from "../lib/format.ts";
import { LEVEL_NAMES, me, planNow, zone } from "../lib/state.ts";

interface Task {
  id: string;
  title: string;
  level: number;
  total_minutes: number;
  due_at: number | null;
  state: string;
  scheduledMinutes: number;
  remainingMinutes: number;
  issue: { status: string; reason: string } | null;
}

export function Tasks() {
  const z = zone();
  const d = me.value?.settings.taskDefaults;
  const [filter, setFilter] = useState<"open" | "done">("open");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(() => ({
    title: "",
    minutes: d?.minutes ?? 60,
    level: d?.level ?? 2,
    splitUp: d?.splitUp ?? true,
    minChunk: d?.minChunkMinutes ?? 30,
    maxChunk: d?.maxChunkMinutes ?? 120,
    due: d?.dueInDays == null ? "" : toLocalInput(z, Date.now() + d.dueInDays * 86_400_000),
  }));

  const load = useCallback(async () => {
    setTasks((await api<{ tasks: Task[] }>("GET", `/api/tasks?status=${filter}`)).tasks);
  }, [filter]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const create = (e: Event) => {
    e.preventDefault();
    void act(async () => {
      await api("POST", "/api/tasks", {
        title: form.title,
        minutes: form.minutes,
        level: form.level,
        splitUp: form.splitUp,
        ...(form.splitUp ? { minChunkMinutes: form.minChunk, maxChunkMinutes: form.maxChunk } : {}),
        dueAt: form.due ? fromLocalInput(z, form.due) : null,
      });
      setForm({ ...form, title: "" });
    });
  };

  return (
    <div class="page" data-testid="tasks-page">
      <h1>Tasks</h1>
      <form class="form" onSubmit={create} data-testid="task-form">
        <label class="wide">
          Title
          <input
            name="title"
            required
            maxLength={255}
            value={form.title}
            onInput={(e) => setForm({ ...form, title: e.currentTarget.value })}
          />
        </label>
        <label>
          Duration (minutes)
          <input
            name="minutes"
            type="number"
            min={15}
            step={15}
            value={form.minutes}
            onInput={(e) => setForm({ ...form, minutes: Number(e.currentTarget.value) })}
          />
        </label>
        <label>
          Priority
          <select
            name="level"
            value={form.level}
            onChange={(e) => setForm({ ...form, level: Number(e.currentTarget.value) })}
          >
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l}>
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
            value={form.due}
            onInput={(e) => setForm({ ...form, due: e.currentTarget.value })}
          />
        </label>
        <label>
          Split into chunks
          <select
            name="splitUp"
            value={form.splitUp ? "yes" : "no"}
            onChange={(e) => setForm({ ...form, splitUp: e.currentTarget.value === "yes" })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        {form.splitUp && (
          <>
            <label>
              Shortest chunk
              <input
                name="minChunk"
                type="number"
                min={15}
                step={15}
                value={form.minChunk}
                onInput={(e) => setForm({ ...form, minChunk: Number(e.currentTarget.value) })}
              />
            </label>
            <label>
              Longest chunk
              <input
                name="maxChunk"
                type="number"
                min={15}
                step={15}
                value={form.maxChunk}
                onInput={(e) => setForm({ ...form, maxChunk: Number(e.currentTarget.value) })}
              />
            </label>
          </>
        )}
        <button type="submit" class="primary">
          Add task
        </button>
      </form>
      {error && <p class="error">{error}</p>}
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
              <div>{t.title}</div>
              <div class="meta">
                {LEVEL_NAMES[t.level]} · {duration(t.total_minutes)}
                {t.due_at ? ` · due ${formatWhen(z, t.due_at)}` : ""} ·{" "}
                <span data-testid="task-state">{t.state}</span>
                {t.scheduledMinutes > 0 ? ` · ${duration(t.scheduledMinutes)} planned` : ""}
                {t.issue && <span class="badge risk"> {t.issue.reason}</span>}
              </div>
            </div>
            <div class="actions">
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
