// Settings added for tasks, alerts, hours and travel: task placement
// (planning-tasks.md TSK-70), auto-lock (planning-locks.md LCK-30), in-app alerts (planning-notifications.md),
// deleting a custom hours set with a replacement (planning-hours.md HRS-10),
// the zone that hours apply in (HRS-13, HRS-14, edge case 6), travel time
// zones (timezones-home-and-travel.md rules 6, 7, 12) and the focus time
// description (tools-pomodoro-timer.md rule 19).
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { Settings } from "../../server/settings.ts";
import { ApiError, api } from "../lib/api.ts";
import { planNow } from "../lib/state.ts";

type Act = (fn: () => Promise<unknown>, done?: string) => Promise<unknown>;

export function PlacementSetting({ settings, act }: { settings: Settings; act: Act }) {
  return (
    <label>
      Task placement
      <select
        value={settings.taskPlacement}
        onChange={(e) =>
          void act(() => api("PATCH", "/api/settings", { taskPlacement: e.currentTarget.value }))
        }
      >
        <option value="chunks">Task events in my calendar</option>
        <option value="suggestions">Suggestions only (no task events)</option>
      </select>
    </label>
  );
}

/** planning-task-progress.md PRG-1, PRG-3: when a chunk or habit event counts as done. */
export function StartModeSetting({ settings, act }: { settings: Settings; act: Act }) {
  return (
    <label>
      Start mode
      <select
        value={settings.startMode}
        onChange={(e) =>
          void act(() => api("PATCH", "/api/settings", { startMode: e.currentTarget.value }))
        }
      >
        <option value="auto">Count when the time passes</option>
        <option value="manual">Count only after I press Start</option>
      </select>
    </label>
  );
}

const AUTO_LOCK = [
  ["meeting", "Flexible meetings"],
  ["habit", "Habits"],
  ["task", "Tasks"],
  ["focus", "Focus time"],
] as const;

/** planning-locks.md LCK-30 to LCK-32: lock each kind's events of the day or the week. */
export function AutoLockSettings({ settings, act }: { settings: Settings; act: Act }) {
  return (
    <section>
      <h2>Auto-lock</h2>
      <p class="status">
        Each day between 01:00 and 02:00, Tempoloom locks the events that start that day, or on the
        first day of the week those of the week. Events placed later stay unlocked; turn the setting
        off and on to lock them at once.
      </p>
      <div class="form" data-testid="auto-lock">
        {AUTO_LOCK.map(([kind, label]) => (
          <label key={kind}>
            {label}
            <select
              value={settings.autoLock[kind]}
              onChange={(e) =>
                void act(() =>
                  api("PATCH", "/api/settings", { autoLock: { [kind]: e.currentTarget.value } }),
                )
              }
            >
              <option value="off">Off</option>
              <option value="day">Each day</option>
              <option value="week">Each week</option>
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

export function AlertSettings({ settings, act }: { settings: Settings; act: Act }) {
  const flag = (key: "tabAlert" | "startChime", label: string) => (
    <label class="inline">
      <input
        type="checkbox"
        checked={settings[key]}
        onChange={(e) =>
          void act(() => api("PATCH", "/api/settings", { [key]: e.currentTarget.checked }))
        }
      />
      {label}
    </label>
  );
  return (
    <section>
      <h2>Alerts</h2>
      <p class="status">These work while a Tempoloom page is open.</p>
      <div class="form">
        {flag("tabAlert", "Flash the tab title when an event starts")}
        {flag("startChime", "Chime when an event starts")}
      </div>
    </section>
  );
}

interface HoursSet {
  id: string;
  kind: string;
  name: string;
}

export function DeleteHoursSet({ set, sets, act }: { set: HoursSet; sets: HoursSet[]; act: Act }) {
  const [count, setCount] = useState<number | null>(null);
  const others = sets.filter((s) => s.id !== set.id);
  const [target, setTarget] = useState(others[0]?.id ?? "");
  return (
    <>
      <button
        type="button"
        class="danger"
        onClick={() =>
          void api<{ count: number }>("GET", `/api/hours/${set.id}/usage`).then((u) =>
            setCount(u.count),
          )
        }
      >
        Delete {set.name}
      </button>
      {count !== null && (
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-hours-title">
            <h2 id="delete-hours-title">Delete {set.name}?</h2>
            {count === 0 ? (
              <p>No items use {set.name}.</p>
            ) : (
              <>
                <p>
                  {count} {count === 1 ? "item uses" : "items use"} {set.name}. Choose other hours
                  for {count === 1 ? "it" : "them"} first.
                </p>
                <label>
                  Move them to
                  <select value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
                    {others.map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <div class="actions">
              <button
                type="button"
                class="danger"
                onClick={() => {
                  const replacementId = count > 0 ? target : undefined;
                  setCount(null);
                  void act(() =>
                    api("DELETE", `/api/hours/${set.id}`, replacementId ? { replacementId } : {}),
                  );
                }}
              >
                {count === 0 ? "Delete" : "Delete and move"}
              </button>
              <button type="button" onClick={() => setCount(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface Travel {
  home: string;
  active: { id: string; tz: string; end_date: string } | null;
  entries: {
    id: string;
    tz: string;
    start_date: string;
    end_date: string;
    active: boolean;
    past: boolean;
  }[];
}
const travel = signal<Travel | null>(null);
const loadTravel = async () => {
  travel.value = await api<Travel>("GET", "/api/travel");
};

/** HRS-13, HRS-14: the zone the hours apply in now; a trip shows here, so a stale one is found. */
export function HoursZoneNote() {
  useEffect(() => void loadTravel(), []);
  const t = travel.value;
  if (!t) return null;
  return (
    <p class="status" data-testid="hours-zone">
      {t.active
        ? `Hours apply in ${t.active.tz} until ${t.active.end_date} (travel time zone), then in ${t.home}.`
        : `Hours apply in ${t.home}.`}
    </p>
  );
}

const ZONES =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function TravelSettings() {
  const [error, setError] = useState<string | null>(null);
  const t = travel.value;
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await loadTravel();
      await planNow();
    } catch (err) {
      const body =
        err instanceof ApiError ? (err.body as { issues?: { message: string }[] }) : null;
      setError(body?.issues?.[0]?.message ?? "That did not work. Check the zone and the dates.");
    }
  };
  return (
    <section>
      <h2>Travel time zones</h2>
      <p class="status">
        On these dates Tempoloom plans hours, habits and booking times in the travel zone, then
        returns to {t?.home ?? "your home zone"}.
      </p>
      <form
        class="form"
        data-testid="travel-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          void run(() =>
            api("POST", "/api/travel", {
              tz: String(f.get("tz") ?? "").trim(),
              startDate: f.get("startDate"),
              endDate: f.get("endDate"),
            }),
          );
        }}
      >
        <label>
          Travel zone
          <input name="tz" list="tl-zones" required placeholder="Asia/Tokyo" />
        </label>
        <datalist id="tl-zones">
          {ZONES.map((z) => (
            <option value={z} key={z} />
          ))}
        </datalist>
        <label>
          From
          <input name="startDate" type="date" required />
        </label>
        <label>
          To
          <input name="endDate" type="date" required />
        </label>
        <button type="submit">Add travel time zone</button>
        {error && (
          <p class="error wide" role="alert" data-testid="travel-error">
            {error}
          </p>
        )}
      </form>
      <div class="list" data-testid="travel-list">
        {t?.entries.map((e) => (
          <div class="row" key={e.id} data-travel-zone={e.tz}>
            <span>
              {e.tz} · {e.start_date} to {e.end_date}
              {e.active ? " · now" : e.past ? " · past" : ""}
            </span>
            <button
              type="button"
              class="danger"
              onClick={() => void run(() => api("DELETE", `/api/travel/${e.id}`))}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

export function FocusNotes({ id, notes, act }: { id: string; notes: string; act: Act }) {
  const [text, setText] = useState(notes);
  return (
    <span class="inline">
      <label class="inline">
        Description
        <input value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </label>
      <button
        type="button"
        onClick={() => void act(() => api("PUT", `/api/focus/${id}/notes`, { notes: text }))}
      >
        Save description
      </button>
    </span>
  );
}
