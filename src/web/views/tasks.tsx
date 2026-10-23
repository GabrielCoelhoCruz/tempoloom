import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { addDays, addLocalDays, localToUtc } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { COLORS } from "../lib/categories.ts";
import { duration, formatWhen, fromLocalInput, toLocalInput } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { useNewest } from "../lib/newest.ts";
import { LEVEL_NAMES, me, planNow, zone } from "../lib/state.ts";
import { Select } from "./event-settings.tsx";
import { type HoursChoice, HoursField } from "./hours-field.tsx";
import { ItemChanges } from "./item-changes.tsx";

const TimerDialog = lazyComponent<{ onClose: () => void }>(() =>
  import("./timer-dialog.tsx").then((m) => m.TimerDialog),
);

interface Task extends TaskFields {
  visibility: "calendar_default" | "private";
  schedulingRank: number | null;
  state: string;
  scheduledMinutes: number;
  remainingMinutes: number;
  inProgress: boolean;
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
  const hoursSet = task
    ? task.hours_set_id !== work?.id
      ? task.hours_set_id
      : ""
    : hours.some((h) => h.id === d?.hoursSetId)
      ? (d?.hoursSetId ?? "")
      : "";
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
        nextUp: d?.nextUp ? "on" : "",
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
          visibility: text("visibility"),
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
        <HoursField sets={hours} initial={hoursSet} allowItem={false} />
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
        {!task && (
          <label>
            Visibility
            <select name="visibility">
              <option value="calendar_default" selected={d?.visibility !== "private"}>
                Calendar default
              </option>
              <option value="private" selected={d?.visibility === "private"}>
                Private
              </option>
            </select>
          </label>
        )}
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

type StateFilter = "open" | "scheduled" | "time-used" | "done";
type Sort = "due" | "priority" | "scheduling";

const STATES: [StateFilter, string][] = [
  ["open", "Open"],
  ["scheduled", "Scheduled"],
  ["time-used", "Time used"],
  ["done", "Done"],
];

/** The list view in the address (TSK-60, TSK-61), so a reload keeps it. */
interface View {
  state: StateFilter;
  hours: string;
  /** Local dates "YYYY-MM-DD" or "". */
  dueBy: string;
  startsFrom: string;
  sort: Sort;
}

function readView(): View {
  const q = new URLSearchParams(location.search);
  const pick = <T extends string>(k: string, all: readonly T[], d: T): T =>
    all.includes(q.get(k) as T) ? (q.get(k) as T) : d;
  return {
    state: pick("state", ["open", "scheduled", "time-used", "done"], "open"),
    hours: q.get("hours") ?? "",
    dueBy: q.get("due") ?? "",
    startsFrom: q.get("start") ?? "",
    sort: pick("sort", ["due", "priority", "scheduling"], "due"),
  };
}

function writeView(v: View) {
  const q = new URLSearchParams();
  if (v.state !== "open") q.set("state", v.state);
  if (v.hours) q.set("hours", v.hours);
  if (v.dueBy) q.set("due", v.dueBy);
  if (v.startsFrom) q.set("start", v.startsFrom);
  if (v.sort !== "due") q.set("sort", v.sort);
  const s = q.toString();
  history.replaceState(history.state, "", `${location.pathname}${s ? `?${s}` : ""}`);
}

/** The tasks the view shows, in its order. The server sends them by due date. */
function shown(tasks: Task[], v: View, z: string): Task[] {
  const dueEnd = v.dueBy ? localToUtc(z, addDays(v.dueBy, 1), 0) : null;
  const startFrom = v.startsFrom ? localToUtc(z, v.startsFrom, 0) : null;
  const list = tasks.filter(
    (t) =>
      (v.state === "open" || v.state === "done" || t.state === v.state) &&
      (!v.hours || t.hours_set_id === v.hours) &&
      (dueEnd === null || (t.due_at !== null && t.due_at < dueEnd)) &&
      (startFrom === null || t.start_after >= startFrom),
  );
  const last = Number.POSITIVE_INFINITY;
  if (v.sort === "priority") return [...list].sort((a, b) => a.level - b.level);
  if (v.sort === "scheduling")
    return [...list].sort((a, b) => (a.schedulingRank ?? last) - (b.schedulingRank ?? last));
  return list;
}

const SNOOZES: [string, string][] = [
  ["1h", "1 hour"],
  ["3h", "3 hours"],
  ["tomorrow", "Tomorrow"],
  ["next-week", "Next week"],
];

/** Snooze (TSK-24) and visibility (CNT-20) of one task. */
function TaskMore({ task, act }: { task: Task; act: (fn: () => Promise<unknown>) => unknown }) {
  const z = zone();
  const [until, setUntil] = useState("");
  return (
    <details class="task-more" data-testid="task-more">
      <summary>More</summary>
      {task.state !== "done" && (
        <div class="actions">
          <span class="meta">Snooze:</span>
          {SNOOZES.map(([choice, label]) => (
            <button
              type="button"
              key={choice}
              onClick={() =>
                void act(() => api("POST", `/api/tasks/${task.id}/snooze`, { choice }))
              }
            >
              {label}
            </button>
          ))}
          <label class="inline">
            Snooze until
            <input
              type="datetime-local"
              value={until}
              onInput={(e) => setUntil(e.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            disabled={!until}
            onClick={() =>
              void act(() =>
                api("POST", `/api/tasks/${task.id}/snooze`, { until: fromLocalInput(z, until) }),
              )
            }
          >
            Snooze
          </button>
        </div>
      )}
      <label class="inline">
        Visibility
        <select
          value={task.visibility}
          onChange={(e) => {
            const visibility = e.currentTarget.value;
            void act(() => api("PATCH", `/api/tasks/${task.id}`, { visibility }));
          }}
        >
          <option value="calendar_default">Calendar default</option>
          <option value="private">Private</option>
        </select>
      </label>
    </details>
  );
}

/** TSK-45: one change to the selected tasks. */
function BulkBar({
  ids,
  act,
  clear,
}: {
  ids: string[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  clear: () => void;
}) {
  const z = zone();
  const [level, setLevel] = useState("2");
  const [start, setStart] = useState("");
  const [due, setDue] = useState("");
  const bulk = (change: Record<string, unknown>) =>
    act(() => api("POST", "/api/tasks/bulk", { ids, change }));
  return (
    <div class="toolbar bulk-bar" data-testid="bulk-bar">
      <span class="meta">{ids.length} selected</span>
      <label class="inline">
        Priority
        <select value={level} onChange={(e) => setLevel(e.currentTarget.value)}>
          {[1, 2, 3, 4].map((l) => (
            <option value={l} key={l}>
              {LEVEL_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => void bulk({ action: "level", level: Number(level) })}>
        Set priority
      </button>
      <label class="inline">
        Start after
        <input
          type="datetime-local"
          value={start}
          onInput={(e) => setStart(e.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        disabled={!start}
        onClick={() => void bulk({ action: "start", startAfter: fromLocalInput(z, start) })}
      >
        Set start
      </button>
      <span class="meta" data-testid="bulk-start-note">
        Locked chunks keep their time.
      </span>
      <label class="inline">
        Due
        <input type="datetime-local" value={due} onInput={(e) => setDue(e.currentTarget.value)} />
      </label>
      <button
        type="button"
        onClick={() => void bulk({ action: "due", dueAt: due ? fromLocalInput(z, due) : null })}
      >
        Set due
      </button>
      <button type="button" onClick={() => void bulk({ action: "done" }).then(clear)}>
        Mark done
      </button>
      <button
        type="button"
        class="danger"
        onClick={() => void bulk({ action: "delete" }).then(clear)}
      >
        Delete
      </button>
    </div>
  );
}

export function Tasks() {
  const z = zone();
  const [view, setViewState] = useState<View>(readView);
  const setView = (patch: Partial<View>) =>
    setViewState((v) => {
      const next = { ...v, ...patch };
      writeView(next);
      return next;
    });
  const filter = view.state === "done" ? "done" : "open";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hours, setHours] = useState<HoursChoice[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [timer, setTimer] = useState<Timer | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const dragged = useRef<Task | null>(null);
  const [editId, setEditId] = useState(() => new URLSearchParams(location.search).get("edit"));
  const editing = editId ? tasks.find((t) => t.id === editId) : undefined;
  const [loaded, setLoaded] = useState(false);

  // A load reads the list of the view shown when it starts, also when an action
  // or a live update that started in another view calls it; the open and the
  // done list have their own URLs, so only the newest load may draw.
  const shownFilter = useRef(filter);
  shownFilter.current = filter;
  const newest = useNewest();
  const load = useCallback(async () => {
    const isNewest = newest();
    const [t, tm] = await Promise.all([
      api<{ tasks: Task[] }>("GET", `/api/tasks?status=${shownFilter.current}`),
      api<{ timer: Timer | null }>("GET", "/api/timer"),
    ]);
    if (!isNewest()) return;
    setTasks(t.tasks);
    setTimer(tm.timer);
    setLoaded(true);
  }, [newest]);
  useEffect(() => void load(), [load, filter]);
  useEffect(() => {
    void api<{ hours: HoursChoice[] }>("GET", "/api/hours").then((h) => setHours(h.hours));
  }, []);
  useLive(load);
  const closeEdit = async () => {
    writeView(view);
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
  // The whole queue gives the positions of a drop; the view filters what it shows.
  const queue =
    filter === "open"
      ? tasks
          .filter((t) => t.next_up_rank !== null)
          .sort((a, b) => (a.next_up_rank ?? 0) - (b.next_up_rank ?? 0))
      : [];
  const list = shown(tasks, view, z);
  const inView = new Set(list.map((t) => t.id));
  const queueShown = queue.filter((t) => inView.has(t.id));
  const others = filter === "open" ? list.filter((t) => t.next_up_rank === null) : list;
  const picked = list.filter((t) => selected.has(t.id)).map((t) => t.id);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const now = Date.now();

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
      <input
        type="checkbox"
        aria-label={`Select ${t.title}`}
        checked={selected.has(t.id)}
        onChange={(e) => toggle(t.id, e.currentTarget.checked)}
      />
      <div>
        <div>
          {t.title}
          {t.next_up_rank !== null && <span class="badge"> next up</span>}
          {t.visibility === "private" && (
            <span class="badge" data-testid="task-private">
              {" "}
              private
            </span>
          )}
        </div>
        <div class="meta">
          <span data-testid="task-level">{LEVEL_NAMES[t.level]}</span> · {duration(t.total_minutes)}
          {t.start_after > now && t.state !== "done" && (
            <>
              {" "}
              · starts{" "}
              <span data-testid="task-start" data-at={t.start_after}>
                {formatWhen(z, t.start_after)}
              </span>
            </>
          )}
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
        <TaskMore task={t} act={act} />
        <ItemChanges kind="task" id={t.id} />
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
            onClick={() => void act(() => api("POST", `/api/tasks/${t.id}/start`))}
          >
            Start now
          </button>
        )}
        {filter === "open" && t.inProgress && (
          <>
            <span class="badge" data-testid="task-started">
              In progress
            </span>
            <button
              type="button"
              title="Stop: the running chunk ends now"
              onClick={() => void act(() => api("POST", `/api/tasks/${t.id}/stop`))}
            >
              End now
            </button>
            <button
              type="button"
              title="Restart: the running chunk starts again now"
              onClick={() => void act(() => api("POST", `/api/tasks/${t.id}/restart`))}
            >
              Restart
            </button>
          </>
        )}
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
      <div data-testid="task-filter">
        <div class="toolbar" data-testid="task-states" style={{ padding: "0 0 8px", border: 0 }}>
          {STATES.map(([state, label]) => (
            <button
              type="button"
              key={state}
              aria-pressed={view.state === state}
              onClick={() => setView({ state })}
            >
              {label}
            </button>
          ))}
        </div>
        <div class="toolbar" data-testid="task-filters" style={{ padding: "0 0 8px", border: 0 }}>
          <label class="inline">
            Hours
            <select value={view.hours} onChange={(e) => setView({ hours: e.currentTarget.value })}>
              <option value="">Any hours</option>
              {hours.map((h) => (
                <option value={h.id} key={h.id}>
                  {h.kind === "work" ? "Work hours" : h.name}
                </option>
              ))}
            </select>
          </label>
          <label class="inline">
            Due by
            <input
              type="date"
              value={view.dueBy}
              onInput={(e) => setView({ dueBy: e.currentTarget.value })}
            />
          </label>
          <label class="inline">
            Starts from
            <input
              type="date"
              value={view.startsFrom}
              onInput={(e) => setView({ startsFrom: e.currentTarget.value })}
            />
          </label>
          <label class="inline">
            Sort
            <select
              value={view.sort}
              onChange={(e) => setView({ sort: e.currentTarget.value as Sort })}
            >
              <option value="due">Due date</option>
              <option value="priority">Priority</option>
              {filter === "open" && <option value="scheduling">Scheduling order</option>}
            </select>
          </label>
        </div>
      </div>
      {picked.length > 0 && <BulkBar ids={picked} act={act} clear={() => setSelected(new Set())} />}
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
          <ol class="list">{queueShown.map((t) => row(t, true))}</ol>
          {queueShown.length === 0 && (
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
        {list.length === 0 && (
          <li class="status">
            No {STATES.find(([s]) => s === view.state)?.[1].toLowerCase()} tasks.
          </li>
        )}
      </ol>
    </div>
  );
}
