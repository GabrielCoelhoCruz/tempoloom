import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { duration, hhmm } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { freeName, templateFromUrl } from "../lib/library.ts";
import { loadPolicyMarks, PolicyMark, policyMarks } from "../lib/policy-marks.tsx";
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
  defense: string;
}

interface HoursSet {
  id: string;
  kind: string;
  name: string;
}

const TeamHabitTemplates = lazyComponent(() =>
  import("./team-recommendations.tsx").then((m) => m.TeamHabitTemplates),
);

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFENSE: Record<string, string> = {
  adaptive: "Free until time gets short",
  "always-free": "Always free",
  "always-busy": "Always busy",
};

export function Habits() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [hours, setHours] = useState<HoursSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A library entry fills the form (automations-library.md rule 5).
  const template = templateFromUrl();
  const preset = template?.kind === "habit" ? template.preset : null;
  const personal = hours.find((h) => h.kind === "personal")?.id;

  const load = useCallback(async () => {
    const [h, hs] = await Promise.all([
      api<{ habits: Habit[] }>("GET", "/api/habits"),
      api<{ hours: HoursSet[] }>("GET", "/api/hours"),
    ]);
    setHabits(h.habits);
    setHours(hs.hours);
    await loadPolicyMarks();
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
    const formEl = e.currentTarget as HTMLFormElement;
    const f = new FormData(formEl);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const days = f.getAll("days").map(Number);
    const words = text("reservedWords")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    void act(async () => {
      await api("POST", "/api/habits", {
        title: text("title"),
        level: Number(f.get("level")),
        idealTime: text("idealTime"),
        minMinutes: Number(f.get("minMinutes")),
        maxMinutes: Number(f.get("maxMinutes")),
        frequency: days.length ? { period: "weekly", days } : { period: "daily" },
        defense: text("defense"),
        whenUnplaceable: text("whenUnplaceable"),
        ...(words.length ? { reservedWords: words } : {}),
        ...(text("starting") ? { starting: text("starting") } : {}),
        ...(text("notes") ? { notes: text("notes") } : {}),
        ...(text("hoursSetId") ? { hoursSetId: text("hoursSetId") } : {}),
      });
      const title = formEl.elements.namedItem("title") as HTMLInputElement | null;
      if (title) title.value = "";
    });
  };

  return (
    <div class="page" data-testid="habits-page">
      <h1>Habits</h1>
      <TeamHabitTemplates habits={habits.map((h) => h.title)} onAdded={load} />
      <form
        class="form"
        onSubmit={create}
        data-testid="habit-form"
        key={template ? `${template.slug}-${habits.length}-${hours.length}` : "new"}
      >
        <label class="wide">
          Title
          <input
            name="title"
            required
            maxLength={255}
            defaultValue={
              template
                ? freeName(
                    template.name,
                    habits.map((h) => h.title),
                  )
                : ""
            }
          />
        </label>
        <label>
          Ideal time
          <input
            name="idealTime"
            type="time"
            step={900}
            defaultValue={preset?.idealTime ?? "12:00"}
          />
        </label>
        <label>
          Shortest (minutes)
          <input
            name="minMinutes"
            type="number"
            min={15}
            step={15}
            defaultValue={String(preset?.minutes ?? 30)}
          />
        </label>
        <label>
          Longest (minutes)
          <input
            name="maxMinutes"
            type="number"
            min={15}
            step={15}
            defaultValue={String(preset?.minutes ?? 60)}
          />
        </label>
        <label>
          Priority
          <select name="level">
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l} selected={l === (preset?.level ?? 3)}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hours
          <select name="hoursSetId">
            <option value="">Work hours</option>
            {hours
              .filter((h) => h.kind !== "work")
              .map((h) => (
                <option
                  value={h.id}
                  key={h.id}
                  selected={preset?.hours === "personal" && h.id === personal}
                >
                  {h.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Show as
          <select name="defense">
            {Object.entries(DEFENSE).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          When there is no room
          <select name="whenUnplaceable">
            <option value="keep_as_conflict">Keep and mark the conflict</option>
            <option value="remove">Remove that day</option>
          </select>
        </label>
        <label>
          Starting
          <input name="starting" type="date" />
        </label>
        <label>
          Skip days with events named (comma list)
          <input name="reservedWords" placeholder="lunch, offsite" />
        </label>
        <fieldset class="wide days">
          <legend>Days (none selected: every day of its hours)</legend>
          {DAY_NAMES.map((n, i) => (
            <label key={n} class="inline">
              <input
                type="checkbox"
                name="days"
                value={i + 1}
                defaultChecked={preset?.days?.includes(i + 1) ?? false}
              />
              {n}
            </label>
          ))}
        </fieldset>
        <label class="wide">
          Notes
          <textarea name="notes" rows={2} />
        </label>
        <button type="submit" class="primary">
          Add habit
        </button>
      </form>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="list" data-testid="habit-list">
        {habits.map((h) => {
          const f = JSON.parse(h.frequency) as { period: string; days?: number[] };
          return (
            <div class="row" key={h.id} data-testid="habit-row" data-habit-title={h.title}>
              <div>
                <div>{h.title}</div>
                <div class="meta">
                  {LEVEL_NAMES[h.level]} · ideal {hhmm(h.ideal_minute)} · {duration(h.min_minutes)}{" "}
                  to {duration(h.max_minutes)} ·{" "}
                  {f.period === "daily"
                    ? "daily"
                    : (f.days ?? []).map((d) => DAY_NAMES[d - 1]).join(", ")}{" "}
                  · {DEFENSE[h.defense] ?? h.defense}
                  {h.enabled ? "" : " · off"} <PolicyMark id={h.id} />
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
                {!policyMarks.value[h.id] && (
                  <button
                    type="button"
                    class="danger"
                    onClick={() => void act(() => api("DELETE", `/api/habits/${h.id}`))}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {habits.length === 0 && <p class="status">No habits yet.</p>}
      </div>
    </div>
  );
}
