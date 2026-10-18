import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { duration, hhmm } from "../lib/format.ts";
import { LEVEL_NAMES, planNow } from "../lib/state.ts";

interface Habit {
  id: string;
  title: string;
  level: number;
  enabled: number;
  ideal_minute: number;
  min_minutes: number;
  max_minutes: number;
  frequency: string;
  hours_set_id: string;
}

interface HoursSet {
  id: string;
  name: string;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Habits() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [hours, setHours] = useState<HoursSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    level: 3,
    idealTime: "12:00",
    minMinutes: 30,
    maxMinutes: 60,
    days: [] as number[],
    hoursSetId: "",
    whenUnplaceable: "keep_as_conflict",
  });

  const load = useCallback(async () => {
    const [h, hs] = await Promise.all([
      api<{ habits: Habit[] }>("GET", "/api/habits"),
      api<{ hours: HoursSet[] }>("GET", "/api/hours"),
    ]);
    setHabits(h.habits);
    setHours(hs.hours);
  }, []);
  useEffect(() => void load(), [load]);

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
    void act(async () => {
      await api("POST", "/api/habits", {
        title: form.title,
        level: form.level,
        idealTime: form.idealTime,
        minMinutes: form.minMinutes,
        maxMinutes: form.maxMinutes,
        frequency: form.days.length ? { period: "weekly", days: form.days } : { period: "daily" },
        whenUnplaceable: form.whenUnplaceable,
        ...(form.hoursSetId ? { hoursSetId: form.hoursSetId } : {}),
      });
      setForm({ ...form, title: "" });
    });
  };

  return (
    <div class="page" data-testid="habits-page">
      <h1>Habits</h1>
      <form class="form" onSubmit={create} data-testid="habit-form">
        <label class="wide">
          Title
          <input
            name="title"
            required
            value={form.title}
            onInput={(e) => setForm({ ...form, title: e.currentTarget.value })}
          />
        </label>
        <label>
          Ideal time
          <input
            name="idealTime"
            type="time"
            step={900}
            value={form.idealTime}
            onInput={(e) => setForm({ ...form, idealTime: e.currentTarget.value })}
          />
        </label>
        <label>
          Shortest (minutes)
          <input
            name="minMinutes"
            type="number"
            min={15}
            step={15}
            value={form.minMinutes}
            onInput={(e) => setForm({ ...form, minMinutes: Number(e.currentTarget.value) })}
          />
        </label>
        <label>
          Longest (minutes)
          <input
            name="maxMinutes"
            type="number"
            min={15}
            step={15}
            value={form.maxMinutes}
            onInput={(e) => setForm({ ...form, maxMinutes: Number(e.currentTarget.value) })}
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
          Hours
          <select
            name="hoursSetId"
            value={form.hoursSetId}
            onChange={(e) => setForm({ ...form, hoursSetId: e.currentTarget.value })}
          >
            <option value="">Work hours</option>
            {hours.map((h) => (
              <option value={h.id} key={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          When there is no room
          <select
            name="whenUnplaceable"
            value={form.whenUnplaceable}
            onChange={(e) => setForm({ ...form, whenUnplaceable: e.currentTarget.value })}
          >
            <option value="keep_as_conflict">Keep and mark the conflict</option>
            <option value="remove">Remove that day</option>
          </select>
        </label>
        <fieldset class="wide days">
          <legend>Days (none selected: every day of its hours)</legend>
          {DAY_NAMES.map((n, i) => (
            <label key={n} class="inline">
              <input
                type="checkbox"
                checked={form.days.includes(i + 1)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    days: e.currentTarget.checked
                      ? [...form.days, i + 1].sort()
                      : form.days.filter((d) => d !== i + 1),
                  })
                }
              />
              {n}
            </label>
          ))}
        </fieldset>
        <button type="submit" class="primary">
          Add habit
        </button>
      </form>
      {error && <p class="error">{error}</p>}
      <div class="list" data-testid="habit-list">
        {habits.map((h) => {
          const f = JSON.parse(h.frequency) as { period: string; days?: number[] };
          return (
            <div class="row" key={h.id} data-testid="habit-row">
              <div>
                <div>{h.title}</div>
                <div class="meta">
                  {LEVEL_NAMES[h.level]} · ideal {hhmm(h.ideal_minute)} · {duration(h.min_minutes)}{" "}
                  to {duration(h.max_minutes)} ·{" "}
                  {f.period === "daily"
                    ? "daily"
                    : (f.days ?? []).map((d) => DAY_NAMES[d - 1]).join(", ")}
                  {h.enabled ? "" : " · off"}
                </div>
              </div>
              <div class="actions">
                <button
                  type="button"
                  onClick={() =>
                    void act(() => api("PATCH", `/api/habits/${h.id}`, { enabled: !h.enabled }))
                  }
                >
                  {h.enabled ? "Turn off" : "Turn on"}
                </button>
                <button
                  type="button"
                  class="danger"
                  onClick={() => void act(() => api("DELETE", `/api/habits/${h.id}`))}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {habits.length === 0 && <p class="status">No habits yet.</p>}
      </div>
    </div>
  );
}
