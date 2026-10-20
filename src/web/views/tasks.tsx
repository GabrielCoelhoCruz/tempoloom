import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { addLocalDays } from "../../shared/time.ts";
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

interface Task extends TaskFields {
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

/** The stored fields of one task, as GET /api/tasks returns them. */
interface TaskFields {
  id: string;
  title: string;
  notes: string;
  level: number;
  total_minutes: number;
  min_chunk_minutes: number;
  max_chunk_minutes: number;
  start_after: number;
  due_at: number | null;
  hours_set_id: string;
  next_up_rank: number | null;
  color: string;
}

/**
 * The task form, on the tasks page and in the New task dialog
 * (planning-tasks.md TSK-1 to TSK-6). With `task` it is the edit form of that
 * task (PRI-50, PRI-53): it starts with the task's values and saves only the
 * fields the user changed. `onSaved` gets the task's title.
 */
export function TaskForm({
  task,
  onSaved,
  onCancel,
  children,
}: {
  task?: TaskFields;
  onSaved: (title: string) => unknown;
  onCancel?: () => unknown;
  children?: ComponentChildren;
}) {
  const z = zone();
  const d = me.value?.settings.taskDefaults;
  const [hours, setHours] = useState<HoursChoice[]>([]);
  const [split, setSplit] = useState(
    task ? task.min_chunk_minutes !== task.max_chunk_minutes : (d?.splitUp ?? true),
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ hours: HoursChoice[] }>("GET", "/api/hours").then((h) => setHours(h.hours));
  }, []);
  const work = hours.find((h) => h.kind === "work");
  // The hours menu shows work hours as "".
  const hoursSet = task && task.hours_set_id !== work?.id ? task.hours_set_id : "";
  // The first value of each field; an edit sends only the fields that differ.
  const initial: Record<string, string> = task
    ? {
        title: task.title,
        notes: task.notes,
        minutes: String(task.total_minutes),
        level: String(task.level),
        due: task.due_at === null ? "" : toLocalInput(z, task.due_at),
        startAfter: toLocalInput(z, task.start_after),
        hoursSetId: hoursSet,
        splitUp: task.min_chunk_minutes !== task.max_chunk_minutes ? "yes" : "no",
        minChunk: String(task.min_chunk_minutes),
        maxChunk: String(task.max_chunk_minutes),
        nextUp: task.next_up_rank === null ? "" : "on",
        taskColor: task.color,
      }
    : {
        minutes: String(d?.minutes ?? 60),
        level: String(d?.level ?? 2),
        due: d?.dueInDays == null ? "" : toLocalInput(z, addLocalDays(Date.now(), d.dueInDays, z)),
        minChunk: String(d?.minChunkMinutes ?? 30),
        maxChunk: String(d?.maxChunkMinutes ?? 120),
        taskColor: "category",
      };

  const submit = (e: Event) => {
    e.preventDefault();
    const formEl = e.currentTarget as HTMLFormElement;
    const f = new FormData(formEl);
    const text = (k: string) => String(f.get(k) ?? "");
    const num = (k: string) => Number(f.get(k));
    const edited = (k: string) => text(k) !== (initial[k] ?? "");
    setError(null);
    void (async () => {
      if (task) {
        const chunks = split && (edited("splitUp") || edited("minChunk") || edited("maxChunk"));
        await api("PATCH", `/api/tasks/${task.id}`, {
          ...(edited("title") ? { title: text("title") } : {}),
          ...(edited("notes") ? { notes: text("notes") } : {}),
          ...(edited("minutes") ? { minutes: num("minutes") } : {}),
          ...(edited("level") ? { level: num("level") } : {}),
          ...(edited("splitUp") ? { splitUp: split } : {}),
          ...(chunks ? { minChunkMinutes: num("minChunk"), maxChunkMinutes: num("maxChunk") } : {}),
          ...(edited("due") ? { dueAt: text("due") ? fromLocalInput(z, text("due")) : null } : {}),
          ...(edited("startAfter") && text("startAfter")
            ? { startAfter: fromLocalInput(z, text("startAfter")) }
            : {}),
          ...(edited("hoursSetId") ? { hoursSetId: text("hoursSetId") || work?.id } : {}),
          ...(edited("taskColor") ? { color: text("taskColor") } : {}),
        });
        if (edited("nextUp"))
          await api(
            "POST",
            `/api/tasks/${task.id}/queue`,
            text("nextUp") === "on" ? {} : { position: null },
          );
      } else {
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
        // Clear the title before the plan runs, and only if it still holds this
        // task: the user may have typed the next title already.
        const title = formEl.elements.namedItem("title") as HTMLInputElement | null;
        if (title && title.value === text("title")) title.value = "";
      }
      await planNow();
      await onSaved(text("title"));
    })().catch((err) => setError(errorText(err)));
  };

  // A new task takes whole quarters of an hour; an edit keeps a stored total
  // that is not one (a default of 50 minutes) unless the user changes it.
  const step = task ? 1 : 15;
  return (
    <>
      <form class="form" onSubmit={submit} data-testid={task ? "task-edit" : "task-form"}>
        {task && <h2 class="wide">Edit task</h2>}
        <label class="wide">
          Title
          <input name="title" required maxLength={255} defaultValue={initial.title ?? ""} />
        </label>
        <label>
          Duration (minutes)
          <input name="minutes" type="number" min={15} step={step} defaultValue={initial.minutes} />
        </label>
        <label>
          Priority
          <select name="level">
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l} selected={String(l) === initial.level}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due
          <input name="due" type="datetime-local" defaultValue={initial.due} />
        </label>
        <label>
          Start after
          <input name="startAfter" type="datetime-local" defaultValue={initial.startAfter ?? ""} />
        </label>
        {/* Remount when the sets load: the menu needs them to show the task's set. */}
        <HoursField key={hours.length} sets={hours} initial={hoursSet} allowItem={false} />
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
                step={step}
                defaultValue={initial.minChunk}
              />
            </label>
            <label>
              Longest chunk
              <input
                name="maxChunk"
                type="number"
                min={15}
                step={step}
                defaultValue={initial.maxChunk}
              />
            </label>
          </>
        )}
        <label class="inline">
          <input name="nextUp" type="checkbox" defaultChecked={initial.nextUp === "on"} />
          Next up (work on it first)
        </label>
        <label class="wide">
          Notes
          <textarea name="notes" rows={2} defaultValue={initial.notes ?? ""} />
        </label>
        <Select
          id="taskColor"
          label="Color"
          initial={initial.taskColor ?? "category"}
          options={[
            ["category", "Category color"],
            ["calendar_default", "Calendar color"],
            ...COLORS.map((c): [string, string] => [c.id, c.name]),
          ]}
        />
        <button type="submit" class="primary">
          {task ? "Save" : "Add task"}
        </button>
        {onCancel && (
          <button type="button" onClick={() => void onCancel()}>
            Cancel
          </button>
        )}
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
  const [over, setOver] = useState(false);
  const dragged = useRef<Task | null>(null);
  const [editId, setEditId] = useState(() => new URLSearchParams(location.search).get("edit"));
  const editing = editId ? tasks.find((t) => t.id === editId) : undefined;
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [t, tm] = await Promise.all([
      api<{ tasks: Task[] }>("GET", `/api/tasks?status=${filter}`),
      api<{ timer: Timer | null }>("GET", "/api/timer"),
    ]);
    setTasks(t.tasks);
    setTimer(tm.timer);
    setLoaded(true);
  }, [filter]);
  useEffect(() => void load(), [load]);
  useLive(load);
  const closeEdit = async () => {
    history.replaceState(null, "", "/tasks");
    setEditId(null);
    await load();
  };

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

  /**
   * NXT-2, NXT-5, NXT-10: puts a task into the next-up queue at `position`
   * (last when undefined), or takes it out with null.
   */
  const toQueue = (t: Task, position?: number | null) =>
    act(() => api("POST", `/api/tasks/${t.id}/queue`, position === undefined ? {} : { position }));
  const queue =
    filter === "open"
      ? tasks
          .filter((t) => t.next_up_rank !== null)
          .sort((a, b) => (a.next_up_rank ?? 0) - (b.next_up_rank ?? 0))
      : [];
  const others = filter === "open" ? tasks.filter((t) => t.next_up_rank === null) : tasks;

  const row = (t: Task, queued: boolean) => (
    <li
      class="row"
      key={t.id}
      data-testid="task-row"
      data-task-title={t.title}
      draggable={filter === "open"}
      onDragStart={(e) => {
        dragged.current = t;
        e.dataTransfer?.setData("text/plain", t.id);
      }}
      onDragEnd={() => {
        dragged.current = null;
        setOver(false);
      }}
      onDragOver={(e) => {
        if (dragged.current && queued) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        if (!queued) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const d = dragged.current;
        // The dropped task takes the target's place: above it when it comes from
        // below or from outside the queue, below it when it comes from above.
        if (d && d.id !== t.id)
          void toQueue(
            d,
            queue.findIndex((x) => x.id === t.id),
          );
      }}
    >
      <div>
        <div>
          {t.title}
          {t.next_up_rank !== null && <span class="badge"> next up</span>}
        </div>
        <div class="meta">
          <span data-testid="task-level">{LEVEL_NAMES[t.level]}</span> · {duration(t.total_minutes)}
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
        {filter === "open" &&
          (queued ? (
            <button
              type="button"
              aria-label="Remove from next up"
              onClick={() => void toQueue(t, null)}
            >
              ↓
            </button>
          ) : (
            <button type="button" aria-label="Add to next up" onClick={() => void toQueue(t)}>
              ↑
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
    </li>
  );

  return (
    <div class="page" data-testid="tasks-page">
      <h1>Tasks</h1>
      {editing ? (
        <TaskForm key={editing.id} task={editing} onSaved={closeEdit} onCancel={closeEdit} />
      ) : (
        <>
          {editId && filter === "open" && loaded && (
            <p class="error" role="alert" data-testid="edit-missing">
              No open task with this id; it may be done or deleted.
            </p>
          )}
          <TaskForm onSaved={load} />
        </>
      )}
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
      <div class="toolbar" style={{ padding: "0 0 8px", border: 0 }} data-testid="task-filter">
        <button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
          Open
        </button>
        <button type="button" aria-pressed={filter === "done"} onClick={() => setFilter("done")}>
          Done
        </button>
      </div>
      {filter === "open" && (
        <section
          class={`next-up-queue${over ? " over" : ""}`}
          aria-label="Next up"
          data-testid="next-up-queue"
          onDragOver={(e) => {
            if (dragged.current) {
              e.preventDefault();
              setOver(true);
            }
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const d = dragged.current;
            if (d) void toQueue(d, queue.filter((x) => x.id !== d.id).length);
          }}
        >
          <h2>Next up</h2>
          <ol class="list">{queue.map((t) => row(t, true))}</ol>
          {queue.length === 0 && (
            <p class="meta">Drag a task here, or use its ↑ button, to work on it first.</p>
          )}
        </section>
      )}
      <ol
        class="list task-list"
        data-testid="task-list"
        onDragOver={(e) => {
          if (dragged.current?.next_up_rank !== null && dragged.current) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const d = dragged.current;
          if (d && d.next_up_rank !== null) void toQueue(d, null);
        }}
      >
        {others.map((t) => row(t, false))}
        {tasks.length === 0 && <li class="status">No {filter} tasks.</li>}
      </ol>
    </div>
  );
}
