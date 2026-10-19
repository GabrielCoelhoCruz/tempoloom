// The automation list (automations-overview.md rules 6-13; planning-priorities.md
// PRI-54): every automation grouped by priority, P1 at the top, in the order the
// scheduler gives them time. Drag an entry to change its rank or its priority.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { useLive } from "../lib/live.ts";
import { loadPolicyMarks, PolicyMark, policyMarks } from "../lib/policy-marks.tsx";
import { onLinkClick } from "../lib/router.ts";
import { LEVEL_NAMES, planNow } from "../lib/state.ts";

interface Automation {
  type: string;
  id: string;
  name: string;
  emoji: string;
  enabled: boolean;
  /** P1 to P4; null for a type without priority (rule 9). */
  level: number | null;
  rank: number;
}

/** One automation type. A new type adds one entry here and one in src/server/api/automations.ts. */
interface TypeInfo {
  label: string;
  plural: string;
  edit: (id: string) => string;
  /** Focus time stays at P4 (rule 8). */
  fixedLevel?: number;
  setEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
}

const TYPES: Record<string, TypeInfo> = {
  habit: {
    label: "Habit",
    plural: "Habits",
    edit: (id) => `/automations/edit/habit/${id}`,
    setEnabled: (id, enabled) => api("PATCH", `/api/habits/${id}`, { enabled }),
    remove: (id) => api("DELETE", `/api/habits/${id}`),
  },
  focus_time: {
    label: "Focus time",
    plural: "Focus time",
    edit: (id) => `/automations/edit/focus_time/${id}`,
    fixedLevel: 4,
    setEnabled: (id, enabled) => api("PATCH", `/api/focus/${id}`, { enabled }),
    remove: (id) => api("DELETE", `/api/focus/${id}`),
  },
  buffer: {
    label: "Buffer",
    plural: "Buffers",
    edit: (id) => `/automations/edit/buffer/${id}`,
    setEnabled: (id, enabled) => api("PATCH", `/api/buffers/${id}`, { enabled }),
    remove: (id) => api("DELETE", `/api/buffers/${id}`),
  },
  flexible_meeting: {
    label: "Flexible meeting",
    plural: "Flexible meetings",
    edit: () => "/meetings",
    setEnabled: (id, enabled) => api("POST", `/api/meetings/${id}/enabled`, { enabled }),
    remove: (id) => api("DELETE", `/api/meetings/${id}`),
  },
};

const same = (a: Automation, b: Automation) => a.type === b.type && a.id === b.id;
const allowed = (a: Automation, level: number | null) =>
  level !== null && a.level !== null && (TYPES[a.type]?.fixedLevel ?? level) === level;

export function Automations() {
  const [list, setList] = useState<Automation[] | null>(null);
  const [filter, setFilter] = useState(
    () => new URLSearchParams(location.search).get("type") ?? "",
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const dragged = useRef<Automation | null>(null);

  const load = useCallback(async () => {
    const [res] = await Promise.all([
      api<{ automations: Automation[] }>("GET", "/api/automations"),
      loadPolicyMarks(),
    ]);
    setList(res.automations);
  }, []);
  useEffect(() => void load(), [load]);
  useLive(load);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
    } catch (err) {
      const body = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(body?.issues?.[0]?.message ?? (err instanceof Error ? err.message : String(err)));
    }
    await load();
  };

  /** Puts `a` into `level` before `before` (or last) and saves the group's order (rule 7). */
  const place = (a: Automation, level: number, before: Automation | null) => {
    if (!list || (before && same(a, before)) || !allowed(a, level)) return;
    const group = list.filter((x) => x.level === level && !same(x, a));
    const at = before ? group.findIndex((x) => same(x, before)) : -1;
    group.splice(at < 0 ? group.length : at, 0, { ...a, level });
    // Show the new order at once; the server answer replaces it.
    setList([...list.filter((x) => x.level !== level && !same(x, a)), ...group]);
    void act(() =>
      api("POST", "/api/automations/order", {
        level,
        items: group.map((x) => ({ type: x.type, id: x.id })),
      }),
    );
  };

  const choose = (type: string) => {
    setFilter(type);
    history.replaceState(null, "", type ? `/automations?type=${type}` : "/automations");
  };

  if (!list) return null;
  const shown = list.filter((a) => !filter || a.type === filter);
  const quality = shown.filter((a) => a.level === null);

  const entry = (a: Automation, group: Automation[]) => {
    const info = TYPES[a.type];
    const key = `${a.type}:${a.id}`;
    const index = group.findIndex((x) => same(x, a));
    const level = a.level;
    return (
      <li
        class={`row automation${a.enabled ? "" : " off"}`}
        key={key}
        data-testid="automation"
        data-type={a.type}
        data-name={a.name}
        draggable={level !== null}
        onDragStart={(e) => {
          dragged.current = a;
          e.dataTransfer?.setData("text/plain", key);
        }}
        onDragEnd={() => {
          dragged.current = null;
          setOver(null);
        }}
        onDragOver={(e) => {
          if (dragged.current && allowed(dragged.current, level)) {
            e.preventDefault();
            e.stopPropagation();
            setOver(level);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(null);
          if (dragged.current && level !== null) place(dragged.current, level, a);
        }}
      >
        <div>
          <div>
            {a.emoji ? `${a.emoji} ` : ""}
            {a.name}
          </div>
          <div class="meta">
            {info?.label ?? a.type}
            {a.enabled ? "" : " · Off"} <PolicyMark id={a.id} />
          </div>
        </div>
        <div class="actions">
          {info && (
            <a class="button" href={info.edit(a.id)} onClick={onLinkClick}>
              Edit
            </a>
          )}
          {level !== null && (
            <>
              <select
                aria-label="Priority"
                value={level}
                disabled={info?.fixedLevel !== undefined}
                title={info?.fixedLevel ? `${info.label} stays at P${info.fixedLevel}` : undefined}
                onChange={(e) => place(a, Number(e.currentTarget.value), null)}
              >
                {[1, 2, 3, 4].map((l) => (
                  <option value={l} key={l}>
                    {LEVEL_NAMES[l]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label="Move up"
                disabled={index <= 0}
                onClick={() => place(a, level, group[index - 1] ?? null)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Move down"
                disabled={index >= group.length - 1}
                onClick={() => place(a, level, group[index + 2] ?? null)}
              >
                ↓
              </button>
            </>
          )}
          {info && (
            <button type="button" onClick={() => void act(() => info.setEnabled(a.id, !a.enabled))}>
              {a.enabled ? "Turn off" : "Turn on"}
            </button>
          )}
          {info && !policyMarks.value[a.id] && (
            <button type="button" class="danger" onClick={() => setConfirming(key)}>
              Remove
            </button>
          )}
        </div>
        {confirming === key && info && (
          <div class="confirm wide" role="alertdialog" aria-label={`Remove ${a.name}`}>
            <span>Remove {a.name} and its future events? Past events stay.</span>
            <button
              type="button"
              class="danger"
              onClick={() => {
                setConfirming(null);
                void act(() => info.remove(a.id));
              }}
            >
              Yes, remove
            </button>
            <button type="button" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div class="page" data-testid="automations-page">
      <h1>Automations</h1>
      <p>
        Higher automations get time first. Drag one to change its rank, or to another group to
        change its priority. Focus time stays at P4 and is placed after everything else.
      </p>
      <div class="actions">
        <label class="inline" for="automation-type">
          Type
        </label>
        <select id="automation-type" value={filter} onChange={(e) => choose(e.currentTarget.value)}>
          <option value="">All types</option>
          {Object.entries(TYPES).map(([type, info]) => (
            <option value={type} key={type}>
              {info.plural}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {[1, 2, 3, 4].map((level) => {
        const group = shown.filter((a) => a.level === level);
        return (
          <section
            key={level}
            class={`automation-group${over === level ? " over" : ""}`}
            aria-label={LEVEL_NAMES[level]}
            data-testid="automation-group"
            data-level={level}
            onDragOver={(e) => {
              if (dragged.current && allowed(dragged.current, level)) {
                e.preventDefault();
                setOver(level);
              }
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              if (dragged.current) place(dragged.current, level, null);
            }}
          >
            <h2>{LEVEL_NAMES[level]}</h2>
            <ol class="list">{group.map((a) => entry(a, group))}</ol>
            {group.length === 0 && <p class="meta">No automations</p>}
          </section>
        );
      })}
      {quality.length > 0 && (
        <section class="automation-group" data-testid="automation-quality">
          <h2>Meeting quality</h2>
          <ol class="list">{quality.map((a) => entry(a, quality))}</ol>
        </section>
      )}
    </div>
  );
}
