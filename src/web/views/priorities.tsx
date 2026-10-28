// The priorities page and the planner priorities view
// (docs/specs/planning-priorities.md PRI-51 to PRI-53; planning-next-up.md NXT-6).
// Both show every item with a priority by level; a drag to another level or the
// level menu on an item changes its level.
import clsx from "clsx/lite";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { onLinkClick } from "../lib/router.ts";
import { LEVEL_NAMES, planNow } from "../lib/state.ts";
import "./priorities.css";

type Kind = "flexible_meeting" | "buffer" | "habit" | "task" | "booking_link" | "focus_time";

interface Item {
  kind: Kind;
  id: string;
  title: string;
  level: number;
  hoursSetId: string | null;
  fixed: boolean;
  nextUp: boolean;
}

/** The kinds in the order the server sends them inside one level. */
const KINDS: Record<Kind, { label: string; plural: string; edit: (id: string) => string }> = {
  flexible_meeting: {
    label: "Flexible meeting",
    plural: "Flexible meetings",
    edit: () => "/meetings",
  },
  buffer: {
    label: "Buffer",
    plural: "Buffers",
    edit: (id) => `/automations/edit/buffer/${id}`,
  },
  habit: { label: "Habit", plural: "Habits", edit: (id) => `/habits?edit=${id}` },
  task: { label: "Task", plural: "Tasks", edit: (id) => `/tasks?edit=${id}` },
  booking_link: {
    label: "Booking link",
    plural: "Booking links",
    edit: (id) => `/links?edit=${id}`,
  },
  focus_time: {
    label: "Focus time",
    plural: "Focus time",
    edit: (id) => `/automations/edit/focus_time/${id}`,
  },
};
const LEVELS = [1, 2, 3, 4];
const WIDTHS = { narrow: 200, normal: 260, wide: 360 } as const;
const WIDTH_KEY = "tl.priorities.width";

const errorText = (err: unknown) =>
  (err as { body?: { issues?: { message: string }[] } }).body?.issues?.[0]?.message ??
  (err instanceof Error ? err.message : String(err));

/** The items, their reload, and the level and queue actions both views share. */
function usePriorities() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragged = useRef<Item | null>(null);
  const load = useCallback(async () => {
    setItems((await api<{ items: Item[] }>("GET", "/api/priorities")).items);
  }, []);
  useEffect(() => void load(), [load]);
  useLive(load);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
    } catch (err) {
      setError(errorText(err));
    }
    await load();
  };
  const setLevel = (it: Item, level: number) => {
    if (it.fixed || it.level === level) return;
    // Show the move at once; the reload replaces it.
    setItems((list) => list?.map((x) => (x === it ? { ...x, level } : x)) ?? null);
    void act(() => api("POST", "/api/priorities", { kind: it.kind, id: it.id, level }));
  };
  const addToQueue = (it: Item) => void act(() => api("POST", `/api/tasks/${it.id}/queue`, {}));
  /** Drag and drop handlers for one level. */
  const dropZone = (level: number, setOver: (l: number | null) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (dragged.current && !dragged.current.fixed) {
        e.preventDefault();
        setOver(level);
      }
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      if (dragged.current) setLevel(dragged.current, level);
    },
  });
  return { items, error, dragged, setLevel, addToQueue, dropZone };
}

function Entry({
  it,
  dragged,
  setLevel,
  addToQueue,
}: {
  it: Item;
  dragged: { current: Item | null };
  setLevel: (it: Item, level: number) => void;
  addToQueue: (it: Item) => void;
}) {
  const info = KINDS[it.kind];
  return (
    <li
      class="row priority-item"
      data-testid="priority-item"
      data-kind={it.kind}
      data-name={it.title}
      draggable={!it.fixed}
      onDragStart={(e) => {
        dragged.current = it;
        e.dataTransfer?.setData("text/plain", `${it.kind}:${it.id}`);
      }}
      onDragEnd={() => {
        dragged.current = null;
      }}
    >
      <div>
        <div>{it.title}</div>
        <div class="meta">
          {info.label}
          {it.nextUp && <span class="badge"> next up</span>}
        </div>
      </div>
      <div class="actions">
        <select
          aria-label="Priority"
          value={it.level}
          disabled={it.fixed}
          title={it.fixed ? `${info.label} stays at P4` : undefined}
          onChange={(e) => setLevel(it, Number(e.currentTarget.value))}
        >
          {LEVELS.map((l) => (
            <option value={l} key={l}>
              {LEVEL_NAMES[l]}
            </option>
          ))}
        </select>
        {it.kind === "task" && !it.nextUp && (
          <button type="button" aria-label="Add to next up" onClick={() => addToQueue(it)}>
            ↑
          </button>
        )}
        <a class="button" href={info.edit(it.id)} onClick={onLinkClick}>
          Edit
        </a>
      </div>
    </li>
  );
}

/** PRI-51, PRI-52: the priorities page, four columns P1 to P4. */
export function Priorities() {
  const p = usePriorities();
  const [kind, setKind] = useState<Kind | "">("");
  const [hours, setHours] = useState("");
  const [sets, setSets] = useState<{ id: string; name: string }[]>([]);
  const [width, setWidth] = useState<keyof typeof WIDTHS>(() => {
    const saved = localStorage.getItem(WIDTH_KEY);
    return saved && saved in WIDTHS ? (saved as keyof typeof WIDTHS) : "normal";
  });
  const [over, setOver] = useState<number | null>(null);
  useEffect(() => {
    void api<{ hours: { id: string; name: string }[] }>("GET", "/api/hours").then((h) =>
      setSets(h.hours),
    );
  }, []);
  if (!p.items) return null;
  const shown = p.items.filter(
    (it) => (!kind || it.kind === kind) && (!hours || it.hoursSetId === hours),
  );
  return (
    <div class="page" style={{ maxWidth: "none" }} data-testid="priorities-page">
      <h1>Priorities</h1>
      <p>
        Higher priorities get time first. Drag an item to another column, or choose its level, to
        change its priority. Focus time stays at P4.
      </p>
      <div class="actions">
        <label class="inline" for="priority-kind">
          Kind
        </label>
        <select
          id="priority-kind"
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value as Kind | "")}
        >
          <option value="">All kinds</option>
          {Object.entries(KINDS).map(([k, info]) => (
            <option value={k} key={k}>
              {info.plural}
            </option>
          ))}
        </select>
        <label class="inline" for="priority-hours">
          Hours
        </label>
        <select id="priority-hours" value={hours} onChange={(e) => setHours(e.currentTarget.value)}>
          <option value="">All hours</option>
          {sets.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label class="inline" for="priority-width">
          Column width
        </label>
        <select
          id="priority-width"
          value={width}
          onChange={(e) => {
            const w = e.currentTarget.value as keyof typeof WIDTHS;
            localStorage.setItem(WIDTH_KEY, w);
            setWidth(w);
          }}
        >
          <option value="narrow">Narrow</option>
          <option value="normal">Normal</option>
          <option value="wide">Wide</option>
        </select>
      </div>
      {p.error && (
        <p class="error" role="alert">
          {p.error}
        </p>
      )}
      <div class="priority-board">
        {LEVELS.map((level) => {
          const column = shown.filter((it) => it.level === level);
          return (
            <section
              key={level}
              class={clsx("priority-column", over === level && "over")}
              style={{ width: `${WIDTHS[width]}px` }}
              aria-label={LEVEL_NAMES[level]}
              data-testid="priority-column"
              data-level={level}
              {...p.dropZone(level, setOver)}
            >
              <h2>{LEVEL_NAMES[level]}</h2>
              <ol class="list">
                {column.map((it) => (
                  <Entry key={`${it.kind}:${it.id}`} it={it} {...p} />
                ))}
              </ol>
              {column.length === 0 && <p class="meta">Nothing at this level</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** PRI-53: the planner priorities view, by level and then by kind, with a search box. */
export function PrioritiesPanel() {
  const p = usePriorities();
  const [query, setQuery] = useState("");
  const [over, setOver] = useState<number | null>(null);
  if (!p.items) return null;
  const q = query.trim().toLowerCase();
  const shown = p.items.filter((it) => !q || it.title.toLowerCase().includes(q));
  return (
    <div class="priorities-panel" data-testid="priorities-panel">
      <label>
        Search
        <input type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      {p.error && <p class="error">{p.error}</p>}
      {LEVELS.map((level) => {
        const atLevel = shown.filter((it) => it.level === level);
        const kinds = (Object.keys(KINDS) as Kind[]).filter((k) =>
          atLevel.some((it) => it.kind === k),
        );
        return (
          <section
            key={level}
            class={clsx("priority-level", over === level && "over")}
            data-testid="priority-level"
            data-level={level}
            {...p.dropZone(level, setOver)}
          >
            <h3>{LEVEL_NAMES[level]}</h3>
            {kinds.map((k) => (
              <div key={k} data-testid="priority-kind" data-kind={k}>
                <h4>{KINDS[k].plural}</h4>
                <ol class="list">
                  {atLevel
                    .filter((it) => it.kind === k)
                    .map((it) => (
                      <Entry key={`${it.kind}:${it.id}`} it={it} {...p} />
                    ))}
                </ol>
              </div>
            ))}
            {atLevel.length === 0 && <p class="meta">Nothing at this level</p>}
          </section>
        );
      })}
    </div>
  );
}
