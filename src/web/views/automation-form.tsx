// The shared automation form (automations-overview.md shared fields): the
// name, the event settings and the rules of a focus time, buffer or habit
// automation. /automations/new/<type>[?template=<slug>] creates one,
// /automations/edit/<type>/<id> changes one.
import { useEffect, useState } from "preact/hooks";
import type { HabitFrequency } from "../../scheduler/model.ts";
import {
  defaultEventSettings,
  type EventSettings,
  readEventSettings,
  type SettingsKind,
} from "../../shared/event-settings.ts";
import { changedHours, fitsOneRange, itemRangeOf, type Weekly } from "../../shared/item-hours.ts";
import { api } from "../lib/api.ts";
import { hhmm } from "../lib/format.ts";
import { readFrequency } from "../lib/frequency.ts";
import { type BufferPreset, entry, freeName, type LibraryEntry } from "../lib/library.ts";
import { navigate, path } from "../lib/router.ts";
import { LEVEL_NAMES, planNow } from "../lib/state.ts";
import { EventSettingsFields, eventSettingsFrom, Select } from "./event-settings.tsx";
import { HabitDependencyFields } from "./habit-dependencies.tsx";
import { FrequencyFields, guestsFrom, HABIT_DECLINE_MESSAGE } from "./habit-editor.tsx";
import { HoursField, ITEM, itemHoursFrom } from "./hours-field.tsx";

interface HoursSet {
  id: string;
  kind: string;
  name: string;
  weekly: Record<string, [number, number][]>;
}

type Row = Record<string, unknown> & {
  id: string;
  title: string;
  event_settings?: string;
  hours_set_id?: string;
};

// Flexible meetings have their own page with these settings (meetings.tsx).
const KINDS: Record<
  Exclude<SettingsKind, "meeting">,
  { name: string; list: string; key: string }
> = {
  habit: { name: "habit", list: "/api/habits", key: "habits" },
  focus_time: { name: "focus time", list: "/api/focus", key: "focus" },
  buffer: { name: "buffer", list: "/api/buffers", key: "buffers" },
};

type Filter = BufferPreset["filter"];

/** The event filters the form offers (buffers-automation.md event filter). */
const FILTERS: { id: string; label: string; filter?: Filter }[] = [
  {
    id: "people",
    label: "Meetings with other people",
    filter: { participants: { op: ">=", value: 2 } },
  },
  { id: "external", label: "External meetings", filter: { categories: ["external_meeting"] } },
  { id: "travel", label: "Events at an address (travel time)", filter: { travel: true } },
  { id: "flight", label: "Flights (airport time)", filter: { flight: true } },
  { id: "words", label: "Events with words in the title" },
];

function choiceOf(filter: Filter): string {
  const json = JSON.stringify(filter);
  const fixed = FILTERS.find((f) => f.filter && JSON.stringify(f.filter) === json);
  if (fixed) return fixed.id;
  const keys = Object.keys(filter);
  if (keys.length === 1 && filter.text?.fields.join() === "title") return "words";
  return "keep";
}

const isTravel = (choice: string, kept: Filter) =>
  choice === "travel" ||
  choice === "flight" ||
  (choice === "keep" && Boolean(kept.travel || kept.flight));

const DEFENSE: Record<string, string> = {
  adaptive: "Free until time gets short",
  "always-free": "Always free",
  "always-busy": "Always busy",
};

function LevelSelect({ value }: { value: number }) {
  return (
    <Select
      id="level"
      label="Priority"
      initial={String(value)}
      options={[1, 2, 3, 4].map((l): [string, string] => [String(l), LEVEL_NAMES[l] ?? ""])}
    />
  );
}

function HoursSelect({ hours, value }: { hours: HoursSet[]; value: string | undefined }) {
  return (
    <Select
      // Keyed by the list, so the choice shows once the hours sets load.
      key={hours.length}
      id="hoursSetId"
      label="Hours"
      initial={value ?? hours.find((h) => h.kind === "work")?.id ?? ""}
      options={hours.map((h): [string, string] => [h.id, h.name])}
    />
  );
}

function FocusRules({
  row,
  hours,
  preset,
}: {
  row: Row | null;
  hours: HoursSet[];
  preset: LibraryEntry | undefined;
}) {
  const p = preset?.kind === "focus_time" ? preset.preset : null;
  const n = (k: string, fallback: number) => (row ? Number(row[k]) : fallback);
  return (
    <>
      <p class="meta wide">Priority: P4 low. Focus time is placed after every other item.</p>
      <label>
        Weekly goal (hours)
        <input
          name="weeklyGoal"
          type="number"
          min={0.5}
          max={40}
          step={0.5}
          required
          defaultValue={String(n("weekly_goal_minutes", p?.weeklyGoalMinutes ?? 600) / 60)}
        />
      </label>
      <label>
        Daily minimum (hours)
        <input
          name="dailyMin"
          type="number"
          min={0}
          max={24}
          step={0.25}
          defaultValue={String(n("daily_min_minutes", 0) / 60)}
        />
      </label>
      <label>
        Daily maximum (hours)
        <input
          name="dailyMax"
          type="number"
          min={0.25}
          max={24}
          step={0.25}
          defaultValue={String(n("daily_max_minutes", 240) / 60)}
        />
      </label>
      <label>
        Shortest block (minutes)
        <input
          name="minBlock"
          type="number"
          min={15}
          step={15}
          defaultValue={String(n("min_block_minutes", p?.minBlockMinutes ?? 60))}
        />
      </label>
      <label>
        Longest block (minutes)
        <input
          name="maxBlock"
          type="number"
          min={15}
          step={15}
          defaultValue={String(n("max_block_minutes", 240))}
        />
      </label>
      <FocusHours row={row} hours={hours} preset={p} />
      <ShowAs busy={row ? row.busy === 1 : true} />
    </>
  );
}

/** The focus row's stored item-specific hours, if it has them. */
const storedHours = (row: Row | null): Weekly | null =>
  row?.item_hours ? (JSON.parse(String(row.item_hours)) as Weekly) : null;

/** Focus hours: a set, or a one-off window (focus-time.md `hours`) as item-specific hours. */
function FocusHours({
  row,
  hours,
  preset,
}: {
  row: Row | null;
  hours: HoursSet[];
  preset: { window?: { days: number[]; from: string; to: string } } | null;
}) {
  const stored = storedHours(row);
  const item = stored ? itemRangeOf(stored) : row ? undefined : preset?.window;
  const work = hours.find((h) => h.kind === "work")?.id;
  const initial = item ? ITEM : !row || row.hours_set_id === work ? "" : String(row.hours_set_id);
  return (
    <>
      <HoursField
        // Keyed by the list, so the choice shows once the hours sets load.
        key={hours.length}
        sets={hours}
        allowItem
        initial={initial}
        {...(item ? { item } : {})}
      />
      {stored && !fitsOneRange(stored) && (
        <p class="meta wide" data-testid="item-hours-note">
          These hours have more than one range: the fields show the first. Saving keeps them all
          unless you change the fields.
        </p>
      )}
    </>
  );
}

function ShowAs({ busy }: { busy: boolean }) {
  return (
    <Select
      id="busy"
      label="Show as"
      initial={busy ? "busy" : "free"}
      options={[
        ["busy", "Busy"],
        ["free", "Free"],
      ]}
    />
  );
}

function BufferRules({
  row,
  preset,
  choice,
  onChoice,
  kept,
}: {
  row: Row | null;
  preset: BufferPreset | null;
  choice: string;
  onChoice: (c: string) => void;
  kept: Filter;
}) {
  const [side, setSide] = useState(String(row?.side ?? preset?.side ?? "after"));
  const before = row ? Number(row.minutes_before) : (preset?.minutesBefore ?? 15);
  const after = row ? Number(row.minutes_after) : (preset?.minutesAfter ?? 15);
  // buffers-travel.md: one travel length for both sides (travel_minutes).
  const travelLength = choice === "travel" || (choice === "keep" && Boolean(kept.travel));
  return (
    <>
      <LevelSelect value={row ? Number(row.level) : (preset?.level ?? 3)} />
      <Select
        id="side"
        label="Side"
        value={side}
        onChange={setSide}
        options={[
          ["before", "Before"],
          ["after", "After"],
          ["both", "Before and after"],
        ]}
      />
      {travelLength ? (
        <label>
          Travel length (minutes)
          <input
            name="travelMinutes"
            type="number"
            min={5}
            max={240}
            step={5}
            defaultValue={String(before || after || 30)}
          />
        </label>
      ) : (
        <>
          {side !== "after" && (
            <label>
              Before the event (minutes)
              <input
                name="minutesBefore"
                type="number"
                min={5}
                max={240}
                step={5}
                defaultValue={String(before || 15)}
              />
            </label>
          )}
          {side !== "before" && (
            <label>
              After the event (minutes)
              <input
                name="minutesAfter"
                type="number"
                min={5}
                max={240}
                step={5}
                defaultValue={String(after || 15)}
              />
            </label>
          )}
        </>
      )}
      <Select
        id="filterChoice"
        label="Which events"
        value={choice}
        onChange={onChoice}
        options={[
          ...FILTERS.map((f): [string, string] => [f.id, f.label]),
          ...(choiceOf(kept) === "keep" ? [["keep", "As set now"] as [string, string]] : []),
        ]}
      />
      {choice === "words" && (
        <label>
          Words to look for
          <input
            name="words"
            required
            placeholder="interview, review"
            defaultValue={kept.text?.values.join(", ") ?? ""}
          />
        </label>
      )}
      <ShowAs busy={row ? row.busy === 1 : (preset?.busy ?? true)} />
      <Select
        id="onConflict"
        label="When the time is taken"
        initial={row?.on_conflict === "keep_as_conflict" ? "keep_as_conflict" : "remove"}
        options={[
          ["remove", "Remove the buffer"],
          ["keep_as_conflict", "Keep and mark the conflict"],
        ]}
      />
    </>
  );
}

function HabitRules({ row, hours }: { row: Row; hours: HoursSet[] }) {
  const frequency = JSON.parse(String(row.frequency)) as HabitFrequency;
  const words = JSON.parse(String(row.reserved_words ?? "[]")) as string[];
  return (
    <>
      <LevelSelect value={Number(row.level)} />
      <label>
        Ideal time
        <input
          name="idealTime"
          type="time"
          step={900}
          defaultValue={hhmm(Number(row.ideal_minute))}
        />
      </label>
      <label>
        Shortest (minutes)
        <input
          name="minMinutes"
          type="number"
          min={15}
          step={15}
          defaultValue={String(row.min_minutes)}
        />
      </label>
      <label>
        Longest (minutes)
        <input
          name="maxMinutes"
          type="number"
          min={15}
          step={15}
          defaultValue={String(row.max_minutes)}
        />
      </label>
      <HoursSelect hours={hours} value={row.hours_set_id} />
      <Select
        id="defense"
        label="Show as"
        initial={String(row.defense)}
        options={Object.entries(DEFENSE)}
      />
      <Select
        id="whenUnplaceable"
        label="When there is no room"
        initial={String(row.when_unplaceable)}
        options={[
          ["keep_as_conflict", "Keep and mark the conflict"],
          ["remove", "Remove that day"],
        ]}
      />
      <label>
        Starting
        <input name="starting" type="date" defaultValue={String(row.starting ?? "")} />
      </label>
      <label>
        Skip days with events named (comma list)
        <input name="reservedWords" defaultValue={words.join(", ")} />
      </label>
      <FrequencyFields preset={frequency} />
      <label class="wide">
        Notes
        <textarea name="notes" rows={2} defaultValue={String(row.notes ?? "")} />
      </label>
      <HabitExtras row={row} />
    </>
  );
}

/** Habit guests, auto-decline (rules 37-39) and dependencies (rule 18). */
function HabitExtras({ row }: { row: Row }) {
  const [decline, setDecline] = useState(Number(row.decline_enabled) === 1);
  const guests = JSON.parse(String(row.guests ?? "[]")) as string[];
  return (
    <>
      <label class="wide">
        Guests (comma list)
        <input name="guests" defaultValue={guests.join(", ")} />
        <span class="meta">
          Added to each event. Tempoloom does not check their availability and sends them no notice.
        </span>
      </label>
      <label class="inline wide">
        <input
          type="checkbox"
          name="declineEnabled"
          checked={decline}
          onChange={(e) => setDecline(e.currentTarget.checked)}
        />
        Decline invitations that overlap this habit while it is busy
      </label>
      {decline && (
        <>
          <label class="wide">
            Decline message
            <input
              name="declineMessage"
              maxLength={500}
              placeholder={HABIT_DECLINE_MESSAGE}
              defaultValue={String(row.decline_message ?? "")}
            />
          </label>
          <p class="meta warning wide">Tempoloom sends these declines to other people.</p>
        </>
      )}
      <HabitDependencyFields habitId={row.id} initial={String(row.dependencies ?? "[]")} />
    </>
  );
}

/** Hours from a number input, as whole quarter hours in minutes. */
const quarterHours = (v: FormDataEntryValue | null) => Math.round((Number(v) * 60) / 15) * 15;

function rulesBody(
  kind: SettingsKind,
  f: FormData,
  kept: Filter,
  hours: HoursSet[],
  row: Row | null,
): Record<string, unknown> {
  const text = (k: string) => String(f.get(k) ?? "").trim();
  const num = (k: string) => Number(f.get(k));
  if (kind === "focus_time") {
    const set = text("hoursSetId");
    const itemHours = set === ITEM ? changedHours(storedHours(row), itemHoursFrom(f)) : undefined;
    return {
      weeklyGoalMinutes: quarterHours(f.get("weeklyGoal")),
      dailyMinMinutes: quarterHours(f.get("dailyMin")),
      dailyMaxMinutes: quarterHours(f.get("dailyMax")),
      minBlockMinutes: num("minBlock"),
      maxBlockMinutes: num("maxBlock"),
      ...(set === ITEM
        ? itemHours
          ? { itemHours }
          : {}
        : { hoursSetId: set || hours.find((h) => h.kind === "work")?.id }),
      busy: text("busy") === "busy",
    };
  }
  if (kind === "buffer") {
    const choice = text("filterChoice");
    const words = text("words")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    const filter =
      choice === "keep"
        ? kept
        : choice === "words"
          ? { text: { values: words, fields: ["title"] } }
          : FILTERS.find((x) => x.id === choice)?.filter;
    const side = text("side");
    const travel = f.has("travelMinutes") ? num("travelMinutes") : null;
    return {
      level: num("level"),
      side,
      minutesBefore: side === "after" ? 0 : (travel ?? num("minutesBefore")),
      minutesAfter: side === "before" ? 0 : (travel ?? num("minutesAfter")),
      busy: text("busy") === "busy",
      filter,
      onConflict: text("onConflict"),
    };
  }
  return {
    level: num("level"),
    idealTime: text("idealTime"),
    minMinutes: num("minMinutes"),
    maxMinutes: num("maxMinutes"),
    hoursSetId: text("hoursSetId"),
    frequency: readFrequency(f),
    defense: text("defense"),
    whenUnplaceable: text("whenUnplaceable"),
    starting: text("starting") || null,
    reservedWords: text("reservedWords")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean),
    notes: String(f.get("notes") ?? ""),
    guests: guestsFrom(text("guests")),
    autoDecline: { enabled: f.has("declineEnabled"), message: text("declineMessage") },
    dependencies: JSON.parse(text("dependencies") || "[]"),
  };
}

export function AutomationForm() {
  const [, , mode, type, itemId] = path.value.split("/");
  const kind = (type && type in KINDS ? type : null) as keyof typeof KINDS | null;
  const id = mode === "edit" ? (itemId ?? "") : null;
  const template = entry(new URLSearchParams(location.search).get("template"));
  const preset = template?.kind === "buffer" ? template.preset : null;
  const [row, setRow] = useState<Row | null | undefined>(id ? undefined : null);
  const [taken, setTaken] = useState<string[] | null>(null);
  const [hours, setHours] = useState<HoursSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);

  useEffect(() => {
    if (!kind) return;
    void (async () => {
      const [list, h, all] = await Promise.all([
        id ? api<Record<string, Row[]>>("GET", KINDS[kind].list) : null,
        api<{ hours: HoursSet[] }>("GET", "/api/hours"),
        api<{ automations: { name: string }[] }>("GET", "/api/automations"),
      ]);
      setHours(h.hours);
      setTaken(all.automations.map((a) => a.name));
      if (list) setRow(list[KINDS[kind].key]?.find((r) => r.id === id) ?? null);
    })();
  }, [kind, id]);

  if (!kind) return <p class="error">Unknown automation type.</p>;
  if (row === undefined || taken === null) return null;
  if (id && row === null) return <p class="error">This automation does not exist.</p>;
  if (kind === "habit" && !row) {
    return (
      <p class="status">
        New habits start on the <a href="/habits">Habits</a> page.
      </p>
    );
  }

  const kept: Filter = row?.filter
    ? (JSON.parse(String(row.filter)) as Filter)
    : (preset?.filter ?? (FILTERS[0]?.filter as Filter));
  const shownChoice = choice ?? choiceOf(kept);
  const travel = kind === "buffer" && isTravel(shownChoice, kept);
  const defaults = defaultEventSettings(kind, { travel });
  const settings: EventSettings = row
    ? readEventSettings(row.event_settings, defaults)
    : { ...defaults, emoji: template?.emoji ?? "" };
  const title = row ? row.title : template ? freeName(template.name, taken) : "";

  const submit = async (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    setError(null);
    setSaving(true);
    try {
      const body = {
        title: String(f.get("title") ?? "").trim(),
        ...rulesBody(kind, f, kept, hours, row),
        eventSettings: eventSettingsFrom(f),
        ...(!row && template ? { templateId: template.slug } : {}),
      };
      if (row) await api("PATCH", `${KINDS[kind].list}/${row.id}`, body);
      else await api("POST", KINDS[kind].list, body);
      await planNow();
      navigate("/automations");
    } catch (err) {
      const b = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(b?.issues?.[0]?.message ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="page" data-testid="automation-form-page">
      <h1>
        {row ? "Edit" : "New"} {KINDS[kind].name}
      </h1>
      <form class="form" data-testid="automation-form" onSubmit={submit}>
        <label class="wide">
          Title
          <input name="title" required maxLength={255} defaultValue={title} />
        </label>
        <EventSettingsFields
          // A new buffer for travel or flights starts with their reminders and visibility.
          key={row ? row.id : `new-${travel}`}
          kind={kind}
          initial={settings}
          editing={row !== null}
        />
        <fieldset class="wide form" data-testid="rules">
          <legend>Rules</legend>
          {kind === "focus_time" && <FocusRules row={row} hours={hours} preset={template} />}
          {kind === "buffer" && (
            <BufferRules
              row={row}
              preset={preset}
              choice={shownChoice}
              onChoice={setChoice}
              kept={kept}
            />
          )}
          {kind === "habit" && row && <HabitRules row={row} hours={hours} />}
        </fieldset>
        {error && (
          <p class="error wide" role="alert">
            {error}
          </p>
        )}
        <div class="actions wide">
          <button type="submit" class="primary" disabled={saving}>
            Save
          </button>
          <button type="button" onClick={() => navigate("/automations")}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
