import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { duration, formatWhen, fromLocalInput, toLocalInput } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { LEVEL_NAMES, me, planNow, zone } from "../lib/state.ts";

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

interface HoursSet {
  id: string;
  kind: string;
  name: string;
}

const REASONS: Record<string, string> = {
  "outside-window": "starts after the planning window",
  "no-hours": "no hours in this period",
  "too-long-for-hours": "a chunk is longer than any range of its hours",
  "all-day-block": "all-day events block every day",
  "no-space-fixed": "no free time",
  "no-space-priority": "higher priorities use the free time",
  "after-due": "part ends after the due date",
};

export function Tasks() {
  const z = zone();
  const d = me.value?.settings.taskDefaults;
  const [filter, setFilter] = useState<"open" | "done">("open");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hours, setHours] = useState<HoursSet[]>([]);
  const [split, setSplit] = useState(d?.splitUp ?? true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setTasks((await api<{ tasks: Task[] }>("GET", `/api/tasks?status=${filter}`)).tasks);
  }, [filter]);
  useEffect(() => void load(), [load]);
  useLive(load);
  useEffect(() => {
    void api<{ hours: HoursSet[] }>("GET", "/api/hours").then((h) => setHours(h.hours));
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
      await load();
    } catch (err) {
      const body = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(body?.issues?.[0]?.message ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  const create = (e: Event) => {
    e.preventDefault();
    const formEl = e.currentTarget as HTMLFormElement;
    const f = new FormData(formEl);
    const text = (k: string) => String(f.get(k) ?? "");
    const num = (k: string) => Number(f.get(k));
    void act(async () => {
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
      });
      const title = formEl.elements.namedItem("title") as HTMLInputElement | null;
      if (title) title.value = "";
    });
  };

  return (
    <div class="page" data-testid="tasks-page">
      <h1>Tasks</h1>
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
        <label>
          Hours
          <select name="hoursSetId">
            <option value="">Work hours</option>
            {hours
              .filter((h) => h.kind !== "work")
              .map((h) => (
                <option value={h.id} key={h.id}>
                  {h.name}
                </option>
              ))}
          </select>
        </label>
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
        <button type="submit" class="primary">
          Add task
        </button>
      </form>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
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
                {t.issue && (
                  <span class="badge risk" data-testid="task-issue">
                    {" "}
                    {REASONS[t.issue.reason] ?? t.issue.reason}
                  </span>
                )}
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
