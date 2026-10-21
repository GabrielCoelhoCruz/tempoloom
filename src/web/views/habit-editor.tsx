// Edit a habit, or make one from a recurring event (habits-automation.md
// rules 5, 6, 8), and the frequency fields (habits "Frequency").
import { useEffect, useState } from "preact/hooks";
import type { HabitFrequency } from "../../scheduler/model.ts";
import { api } from "../lib/api.ts";
import { hhmm } from "../lib/format.ts";
import { DAY_NAMES, MAX_INTERVAL, ORDINALS, readFrequency, WEEKDAYS } from "../lib/frequency.ts";
import { LEVEL_NAMES, planNow } from "../lib/state.ts";
import { TaskSearchPicker } from "./task-search-picker.tsx";

/** Guests from a comma list (habits concepts `guests`). */
export const guestsFrom = (text: string) =>
  text
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

const DEFENSE: Record<string, string> = {
  adaptive: "Free until time gets short",
  "always-free": "Always free",
  "always-busy": "Always busy",
};

/** Day checkboxes, the repeat choice with the fields of a monthly habit, and the interval. */
/** habits-automation.md `ideal_at_end`: the ideal start is the end of each day's hours. */
export function IdealAtEndField({ checked }: { checked: boolean }) {
  return (
    <label class="inline">
      <input type="checkbox" name="idealAtEnd" defaultChecked={checked} />
      Place at the end of each day
    </label>
  );
}

export function FrequencyFields({ preset }: { preset?: HabitFrequency | undefined }) {
  const monthly = preset?.period === "monthly" ? preset : null;
  const days = preset?.period === "weekly" ? preset.days : [];
  const [repeat, setRepeat] = useState(monthly ? ("dayOfMonth" in monthly ? "day" : "nth") : "");
  const [nth, setNth] = useState(monthly && "nth" in monthly ? String(monthly.nth) : "1");
  const [weekday, setWeekday] = useState(
    monthly && "weekday" in monthly ? String(monthly.weekday) : "1",
  );
  return (
    <>
      <fieldset class="wide days">
        <legend>Days (none selected: every day of its hours)</legend>
        {DAY_NAMES.map((n, i) => (
          <label key={n} class="inline">
            <input
              type="checkbox"
              name="days"
              value={i + 1}
              defaultChecked={days.includes(i + 1)}
            />
            {n}
          </label>
        ))}
      </fieldset>
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
            max={MAX_INTERVAL}
            step={1}
            defaultValue={String(preset?.interval ?? 1)}
          />
          <span class="meta">
            1 is every period; 2 is every other day, week or month, counted from the start date when
            you first set it
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
    </>
  );
}

interface HabitRow {
  id: string;
  title: string;
  notes: string;
  level: number;
  ideal_minute: number;
  ideal_at_end: number;
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
  idealAtEnd: boolean;
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
            idealAtEnd: h.ideal_at_end === 1,
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
            idealAtEnd: false,
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
      idealAtEnd: f.has("idealAtEnd"),
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
          <IdealAtEndField checked={draft.idealAtEnd} />
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
          <FrequencyFields preset={draft.frequency} />
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
