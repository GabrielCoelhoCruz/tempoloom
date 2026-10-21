import { useCallback, useEffect, useState } from "preact/hooks";
import type { HabitFrequency } from "../../scheduler/model.ts";
import { defaultEventSettings, readEventSettings } from "../../shared/event-settings.ts";
import { utcToLocal } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { duration, hhmm } from "../lib/format.ts";
import { frequencyText, readFrequency } from "../lib/frequency.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { freeName, templateFromUrl } from "../lib/library.ts";
import { useLive } from "../lib/live.ts";
import { loadPolicyMarks, PolicyMark, policyMarks } from "../lib/policy-marks.tsx";
import { LEVEL_NAMES, planNow, zone } from "../lib/state.ts";
import { EventSettingsFields, eventSettingsFrom } from "./event-settings.tsx";
import {
  type EditorTarget,
  FrequencyFields,
  guestsFrom,
  HabitEditor,
  IdealAtEndField,
} from "./habit-editor.tsx";
import {
  describeWeekly,
  type HoursChoice,
  HoursField,
  ITEM,
  itemHoursFrom,
} from "./hours-field.tsx";

interface Habit {
  id: string;
  title: string;
  level: number;
  enabled: number;
  ideal_minute: number;
  ideal_at_end: number;
  min_minutes: number;
  max_minutes: number;
  frequency: string;
  defense: string;
  event_settings: string;
  /** JSON weekly ranges when the habit has item-specific hours. */
  item_hours: string | null;
  starting: string | null;
}

/** Rule 35: the habit places nothing before this date; its earlier future events go. */
function SnoozeHabit({ habit, act }: { habit: Habit; act: (fn: () => Promise<unknown>) => void }) {
  const [date, setDate] = useState(habit.starting ?? "");
  return (
    <form
      class="inline"
      data-testid="snooze-habit"
      onSubmit={(e) => {
        e.preventDefault();
        act(() => api("PATCH", `/api/habits/${habit.id}`, { starting: date || null }));
      }}
    >
      <label>
        Snooze until
        <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} />
      </label>
      <button type="submit">{date ? "Snooze" : "Clear snooze"}</button>
    </form>
  );
}

const TeamHabitTemplates = lazyComponent(() =>
  import("./team-recommendations.tsx").then((m) => m.TeamHabitTemplates),
);

const DEFENSE: Record<string, string> = {
  adaptive: "Free until time gets short",
  "always-free": "Always free",
  "always-busy": "Always busy",
};

const withEmoji = (h: Habit) => {
  const { emoji } = readEventSettings(h.event_settings, defaultEventSettings("habit"));
  return emoji ? `${emoji} ${h.title}` : h.title;
};

export function Habits() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [hours, setHours] = useState<HoursChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const today = utcToLocal(zone(), Date.now()).date;
  // A library entry fills the form (automations-library.md rule 5).
  const template = templateFromUrl();
  const preset = template?.kind === "habit" ? template.preset : null;
  const personal = hours.find((h) => h.kind === "personal")?.id;
  // Entry 11: the last `minutes` of work hours, from the latest end on any day.
  const workEnd = Math.max(
    0,
    ...Object.values(hours.find((h) => h.kind === "work")?.weekly ?? {}).flatMap((r) =>
      r.map(([, e]) => e),
    ),
  );
  const idealTime =
    preset?.idealAtEnd && workEnd > 0 ? hhmm(workEnd - preset.minutes) : preset?.idealTime;
  // ?edit=<id> edits a habit, ?from=<event> makes one from a recurring event (rules 6, 8).
  const [target, setTarget] = useState<EditorTarget | null>(() => {
    const q = new URLSearchParams(location.search);
    const edit = q.get("edit");
    const from = q.get("from");
    return edit ? { edit } : from ? { from } : null;
  });

  const load = useCallback(async () => {
    const [h, hs] = await Promise.all([
      api<{ habits: Habit[] }>("GET", "/api/habits"),
      api<{ hours: HoursChoice[] }>("GET", "/api/hours"),
    ]);
    setHabits(h.habits);
    setHours(hs.hours);
    await loadPolicyMarks();
  }, []);
  useEffect(() => void load(), [load]);
  useLive(load);

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
    const words = text("reservedWords")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    void act(async () => {
      await api("POST", "/api/habits", {
        title: text("title"),
        level: Number(f.get("level")),
        idealTime: text("idealTime"),
        idealAtEnd: f.has("idealAtEnd"),
        minMinutes: Number(f.get("minMinutes")),
        maxMinutes: Number(f.get("maxMinutes")),
        frequency: readFrequency(f),
        defense: text("defense"),
        whenUnplaceable: text("whenUnplaceable"),
        ...(words.length ? { reservedWords: words } : {}),
        ...(text("starting") ? { starting: text("starting") } : {}),
        ...(text("notes") ? { notes: text("notes") } : {}),
        ...(text("guests") ? { guests: guestsFrom(text("guests")) } : {}),
        ...(text("hoursSetId") === ITEM
          ? { itemHours: itemHoursFrom(f) }
          : text("hoursSetId")
            ? { hoursSetId: text("hoursSetId") }
            : {}),
        eventSettings: eventSettingsFrom(f),
        ...(preset && template ? { templateId: template.slug } : {}),
      });
      const title = formEl.elements.namedItem("title") as HTMLInputElement | null;
      if (title) title.value = "";
      // The template is used: the next habit starts from a blank form.
      if (template) history.replaceState(null, "", "/habits");
    });
  };

  return (
    <div class="page" data-testid="habits-page">
      <h1>Habits</h1>
      <TeamHabitTemplates habits={habits.map((h) => h.title)} onAdded={load} />
      {target && (
        <HabitEditor
          key={JSON.stringify(target)}
          target={target}
          onClose={() => {
            history.replaceState(null, "", "/habits");
            setTarget(null);
            void load();
          }}
        />
      )}
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
          <input name="idealTime" type="time" step={900} defaultValue={idealTime ?? "12:00"} />
        </label>
        <IdealAtEndField checked={preset?.idealAtEnd === true} />
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
        <HoursField
          sets={hours}
          allowItem
          initial={preset?.window ? ITEM : preset?.hours === "personal" && personal ? personal : ""}
          {...(preset?.window ? { item: preset.window } : {})}
        />
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
        <FrequencyFields
          preset={preset?.days ? { period: "weekly", days: preset.days } : undefined}
        />
        <label class="wide">
          Notes
          <textarea name="notes" rows={2} />
        </label>
        <label class="wide">
          Guests (comma list)
          <input name="guests" placeholder="ana@example.com" />
          <span class="meta">
            Added to each event. Tempoloom does not check their availability and sends them no
            notice.
          </span>
        </label>
        <EventSettingsFields
          key={habits.length}
          kind="habit"
          initial={{
            ...defaultEventSettings("habit", { personal: preset?.hours === "personal" }),
            emoji: template?.emoji ?? "",
          }}
        />
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
          const f = JSON.parse(h.frequency) as HabitFrequency;
          return (
            <div class="row" key={h.id} data-testid="habit-row" data-habit-title={h.title}>
              <div>
                <div>{withEmoji(h)}</div>
                <div class="meta">
                  {LEVEL_NAMES[h.level]} ·{" "}
                  {h.ideal_at_end ? "ideal: end of each day" : `ideal ${hhmm(h.ideal_minute)}`} ·{" "}
                  {duration(h.min_minutes)} to {duration(h.max_minutes)} · {frequencyText(f)} ·{" "}
                  {DEFENSE[h.defense] ?? h.defense}
                  {h.item_hours
                    ? ` · Item-specific hours: ${describeWeekly(JSON.parse(h.item_hours))}`
                    : ""}
                  {h.starting && h.starting > today ? ` · snoozed until ${h.starting}` : ""}
                  {h.enabled ? "" : " · off"} <PolicyMark id={h.id} />
                </div>
              </div>
              <div class="actions">
                <SnoozeHabit key={h.starting ?? ""} habit={h} act={(fn) => void act(fn)} />
                <button type="button" onClick={() => setTarget({ edit: h.id })}>
                  Edit
                </button>
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
