// Edit a habit, or make one from a recurring event (habits-automation.md
// rules 5, 6, 8), and the monthly frequency fields (habits "Frequency").
import { useEffect, useState } from "preact/hooks";
import type { BaseFrequency, HabitFrequency } from "../../scheduler/model.ts";
import { api } from "../lib/api.ts";
import { hhmm } from "../lib/format.ts";
import { LEVEL_NAMES, planNow } from "../lib/state.ts";
import { TaskSearchPicker } from "./task-search-picker.tsx";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ORDINALS: Record<string, string> = {
  "1": "1st",
  "2": "2nd",
  "3": "3rd",
  "4": "4th",
  "5": "5th",
  last: "last",
};
const DEFENSE: Record<string, string> = {
  adaptive: "Free until time gets short",
  "always-free": "Always free",
  "always-busy": "Always busy",
};

/** "daily", "Tue, Thu", "monthly on day 15", "monthly on the 2nd Friday" or "every 2 weeks on Tue". */
export function frequencyText(f: HabitFrequency): string {
  if (f.period === "custom") {
    const b = f.of;
    if (b.period === "daily") return `every ${f.interval} days`;
    if (b.period === "weekly") return `every ${f.interval} weeks on ${frequencyText(b)}`;
    return `every ${f.interval} months, ${frequencyText(b).replace("monthly ", "")}`;
  }
  if (f.period === "daily") return "daily";
  if (f.period === "weekly") return f.days.map((d) => DAY_NAMES[d - 1]).join(", ");
  if ("dayOfMonth" in f) return `monthly on day ${f.dayOfMonth}`;
  return `monthly on the ${ORDINALS[String(f.nth)]} ${WEEKDAYS[f.weekday - 1]}`;
}

/** The base frequency of a habit: a custom one repeats it every N periods. */
export const baseOf = (f: HabitFrequency): BaseFrequency => (f.period === "custom" ? f.of : f);

/** The weekdays a weekly or custom weekly frequency uses. */
export const daysOf = (f: HabitFrequency): number[] => {
  const b = baseOf(f);
  return b.period === "weekly" ? b.days : [];
};

/** The frequency the habit form holds: monthly fields first, then the chosen days, then "Repeat every". */
export function readFrequency(f: FormData): HabitFrequency {
  const repeat = String(f.get("repeat") ?? "");
  const days = f.getAll("days").map(Number);
  const base: BaseFrequency =
    repeat === "day"
      ? { period: "monthly", dayOfMonth: Number(f.get("dayOfMonth")) }
      : repeat === "nth"
        ? {
            period: "monthly",
            nth:
              String(f.get("nth")) === "last"
                ? "last"
                : (Number(f.get("nth")) as 1 | 2 | 3 | 4 | 5),
            weekday: Number(f.get("weekday")),
          }
        : days.length
          ? { period: "weekly", days }
          : { period: "daily" };
  const interval = Math.max(1, Math.round(Number(f.get("interval") ?? 1) || 1));
  return interval > 1 ? { period: "custom", interval, of: base } : base;
}

/** Repeat choice with the fields of a monthly habit. */
export function MonthlyFields({ preset }: { preset?: HabitFrequency | undefined }) {
  const base = preset ? baseOf(preset) : null;
  const monthly = base?.period === "monthly" ? base : null;
  const [repeat, setRepeat] = useState(monthly ? ("dayOfMonth" in monthly ? "day" : "nth") : "");
  const [nth, setNth] = useState(monthly && "nth" in monthly ? String(monthly.nth) : "1");
  const [weekday, setWeekday] = useState(
    monthly && "weekday" in monthly ? String(monthly.weekday) : "1",
  );
  return (
    <fieldset class="wide days">
      <legend>Frequency</legend>
      <label>
        Repeat
        <select name="repeat" value={repeat} onChange={(e) => setRepeat(e.currentTarget.value)}>
          <option value="">Every day or on the chosen days</option>
          <option value="day">Monthly on a day</option>
          <option value="nth">Monthly on a weekday</option>
        </select>
      </label>
      <label>
        Interval
        <input
          name="interval"
          type="number"
          min={1}
          max={52}
          step={1}
          defaultValue={String(preset?.period === "custom" ? preset.interval : 1)}
        />
        <span class="meta">
          1 is every period; 2 is every other day, week or month from the start date
        </span>
      </label>
      {repeat === "day" && (
        <label>
          Day of month
          <input
            name="dayOfMonth"
            type="number"
            min={1}
            max={31}
            required
            defaultValue={monthly && "dayOfMonth" in monthly ? String(monthly.dayOfMonth) : ""}
          />
        </label>
      )}
      {repeat === "nth" && (
        <>
          <label>
            Week of month
            <select name="nth" value={nth} onChange={(e) => setNth(e.currentTarget.value)}>
              {Object.entries(ORDINALS).map(([v, l]) => (
                <option value={v} key={v}>
                  {l === "last" ? "Last" : l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Day of the week
            <select
              name="weekday"
              value={weekday}
              onChange={(e) => setWeekday(e.currentTarget.value)}
            >
              {WEEKDAYS.map((w, i) => (
                <option value={i + 1} key={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </fieldset>
  );
}

interface HabitRow {
  id: string;
  title: string;
  notes: string;
  level: number;
  ideal_minute: number;
  min_minutes: number;
  max_minutes: number;
  frequency: string;
  defense: string;
  when_unplaceable: string;
  task_search_id: string | null;
}

interface Draft {
  title: string;
  notes: string;
  level: number;
  idealTime: string;
  min: number;
  max: number;
  frequency: HabitFrequency;
  defense: string;
  whenUnplaceable: string;
  searchId: string | null;
}

export type EditorTarget = { edit: string } | { from: string };

/** The habit editor: `edit` changes a habit, `from` makes one from a recurring event. */
export function HabitEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editId = "edit" in target ? target.edit : null;
  const fromId = "from" in target ? target.from : null;

  useEffect(() => {
    void (async () => {
      setError(null);
      try {
        if (editId) {
          const { habits } = await api<{ habits: HabitRow[] }>("GET", "/api/habits");
          const h = habits.find((x) => x.id === editId);
          if (!h) throw new Error("This habit no longer exists.");
          setDraft({
            title: h.title,
            notes: h.notes,
            level: h.level,
            idealTime: hhmm(h.ideal_minute),
            min: h.min_minutes,
            max: h.max_minutes,
            frequency: JSON.parse(h.frequency) as HabitFrequency,
            defense: h.defense,
            whenUnplaceable: h.when_unplaceable,
            searchId: h.task_search_id,
          });
          setSearchId(h.task_search_id);
        } else if (fromId) {
          const { series } = await api<{
            series: { title: string; idealTime: string; minutes: number; days: number[] };
          }>("GET", `/api/habits/from-event?id=${encodeURIComponent(fromId)}`);
          setDraft({
            title: series.title,
            notes: "",
            level: 3,
            idealTime: series.idealTime,
            min: series.minutes,
            max: series.minutes,
            frequency: series.days.length
              ? { period: "weekly", days: series.days }
              : { period: "daily" },
            defense: "adaptive",
            whenUnplaceable: "keep_as_conflict",
            searchId: null,
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [editId, fromId]);

  const save = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const body = {
      title: text("title"),
      notes: text("notes"),
      level: Number(f.get("level")),
      idealTime: text("idealTime"),
      minMinutes: Number(f.get("minMinutes")),
      maxMinutes: Number(f.get("maxMinutes")),
      frequency: readFrequency(f),
      defense: text("defense"),
      whenUnplaceable: text("whenUnplaceable"),
    };
    setError(null);
    try {
      if (editId) {
        await api("PATCH", `/api/habits/${editId}`, body);
        if (searchId !== (draft?.searchId ?? null)) {
          await api("PUT", "/api/task-searches/assign", {
            kind: "habit",
            id: editId,
            searchId,
          });
        }
      } else {
        await api("POST", "/api/habits", body);
      }
      await planNow();
      onClose();
    } catch (err) {
      const b = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(b?.issues?.[0]?.message ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <section class="card" data-testid="habit-editor">
      <h2>{editId ? "Edit habit" : "New habit from an event"}</h2>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {draft && (
        <form class="form" onSubmit={save} key={`${editId ?? fromId}`}>
          <label class="wide">
            Title
            <input name="title" required maxLength={255} defaultValue={draft.title} />
          </label>
          <label>
            Ideal time
            <input name="idealTime" type="time" step={900} defaultValue={draft.idealTime} />
          </label>
          <label>
            Shortest (minutes)
            <input
              name="minMinutes"
              type="number"
              min={15}
              step={15}
              defaultValue={String(draft.min)}
            />
          </label>
          <label>
            Longest (minutes)
            <input
              name="maxMinutes"
              type="number"
              min={15}
              step={15}
              defaultValue={String(draft.max)}
            />
          </label>
          <label>
            Priority
            <select
              name="level"
              value={String(draft.level)}
              onChange={(e) => setDraft({ ...draft, level: Number(e.currentTarget.value) })}
            >
              {[1, 2, 3, 4].map((l) => (
                <option value={l} key={l}>
                  {LEVEL_NAMES[l]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Show as
            <select
              name="defense"
              value={draft.defense}
              onChange={(e) => setDraft({ ...draft, defense: e.currentTarget.value })}
            >
              {Object.entries(DEFENSE).map(([v, l]) => (
                <option value={v} key={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            When there is no room
            <select
              name="whenUnplaceable"
              value={draft.whenUnplaceable}
              onChange={(e) => setDraft({ ...draft, whenUnplaceable: e.currentTarget.value })}
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
                  name="days"
                  value={i + 1}
                  defaultChecked={daysOf(draft.frequency).includes(i + 1)}
                />
                {n}
              </label>
            ))}
          </fieldset>
          <MonthlyFields preset={draft.frequency} />
          <label class="wide">
            Notes
            <textarea name="notes" rows={2} defaultValue={draft.notes} />
          </label>
          {editId && (
            <div class="wide">
              <TaskSearchPicker value={searchId} onChange={setSearchId} />
            </div>
          )}
          <div class="actions wide">
            <button type="submit" class="primary">
              Save habit
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
