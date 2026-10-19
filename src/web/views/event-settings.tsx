// The event settings part of the automation form (automations-overview.md
// shared fields): emoji, category, color, visibility, reminders, calendar,
// location and description. The inputs are named, so a form reads them with
// eventSettingsFrom().
import { useEffect, useState } from "preact/hooks";
import type { EventSettings, SettingsKind } from "../../shared/event-settings.ts";
import { api } from "../lib/api.ts";
import { COLORS } from "../lib/categories.ts";

interface Calendar {
  id: string;
  name: string;
  is_primary: number;
  writable: number;
}

/** The fields of the form, as the API takes them. Fields the form does not show are left out. */
export function eventSettingsFrom(f: FormData): Partial<EventSettings> {
  const text = (k: string) => (f.has(k) ? String(f.get(k) ?? "").trim() : undefined);
  const out: Partial<EventSettings> = {};
  const emoji = text("es-emoji");
  if (emoji !== undefined) out.emoji = emoji;
  const color = text("es-color");
  if (color) out.color = color as EventSettings["color"];
  const visibility = text("es-visibility");
  if (visibility) out.visibility = visibility as EventSettings["visibility"];
  const reminders = text("es-reminders");
  if (reminders === "custom") out.reminders = [Number(text("es-minutes") || 0)];
  else if (reminders === "default" || reminders === "none") out.reminders = reminders;
  const category = text("es-category");
  if (category) out.category = category as EventSettings["category"];
  const calendar = text("es-calendar");
  if (calendar !== undefined) out.calendarId = calendar || null;
  const location = text("es-location");
  if (location !== undefined) out.location = location;
  if (f.has("es-description")) out.description = String(f.get("es-description") ?? "");
  return out;
}

export function EventSettingsFields({
  kind,
  initial,
  editing = false,
}: {
  kind: SettingsKind;
  initial: EventSettings;
  /** The calendar is set at creation only (habits rule 5). */
  editing?: boolean;
}) {
  const [emoji, setEmoji] = useState(initial.emoji);
  const [reminders, setReminders] = useState(
    Array.isArray(initial.reminders) ? "custom" : initial.reminders,
  );
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const chooseCalendar = kind === "habit" || kind === "focus_time";
  useEffect(() => {
    if (!chooseCalendar) return;
    void api<{ calendars: Calendar[] }>("GET", "/api/calendars").then((c) =>
      setCalendars(c.calendars.filter((x) => x.writable === 1)),
    );
  }, [chooseCalendar]);

  return (
    <fieldset class="wide form" data-testid="event-settings">
      <legend>Event settings</legend>
      <div class="field">
        <label>
          Emoji
          <input
            name="es-emoji"
            value={emoji}
            maxLength={16}
            placeholder="🍱"
            onInput={(e) => setEmoji(e.currentTarget.value)}
          />
        </label>
        {/* events-title-emoji.md rule 4: a template's emoji can be removed. */}
        {emoji && (
          <button type="button" onClick={() => setEmoji("")}>
            Remove emoji
          </button>
        )}
      </div>
      {kind === "habit" && (
        <Select
          id="es-category"
          label="Category"
          initial={initial.category}
          options={[
            ["work", "Work"],
            ["personal", "Personal"],
          ]}
        />
      )}
      <Select
        id="es-color"
        label="Color"
        initial={initial.color}
        options={[
          ["category", "Category color"],
          ["calendar_default", "Calendar color"],
          ...COLORS.map((c): [string, string] => [c.id, c.name]),
        ]}
      />
      <Select
        id="es-visibility"
        label="Visibility"
        initial={initial.visibility}
        options={[
          ["calendar_default", "Calendar default"],
          ["public", "Public"],
          ["private", "Private"],
        ]}
      />
      <Select
        id="es-reminders"
        label="Reminders"
        value={reminders}
        onChange={(v) => setReminders(v as typeof reminders)}
        options={[
          ["default", "Calendar default"],
          ["none", "None"],
          ["custom", "Custom"],
        ]}
      />
      {reminders === "custom" && (
        <label>
          Remind me (minutes)
          <input
            name="es-minutes"
            type="number"
            min={0}
            max={40320}
            required
            defaultValue={String(Array.isArray(initial.reminders) ? initial.reminders[0] : 10)}
          />
        </label>
      )}
      {chooseCalendar && (
        <div class="field">
          <Select
            id="es-calendar"
            label="Calendar"
            initial={initial.calendarId ?? ""}
            disabled={editing}
            options={[
              ["", "Main calendar"],
              ...calendars.map((c): [string, string] => [c.id, c.name]),
            ]}
          />
          {editing && <span class="meta">Set when the automation was created.</span>}
        </div>
      )}
      {kind === "habit" && (
        <label class="wide">
          Location
          <input name="es-location" maxLength={1000} defaultValue={initial.location} />
        </label>
      )}
      {kind === "focus_time" && (
        <label class="wide">
          Description
          <textarea name="es-description" rows={2} defaultValue={initial.description} />
        </label>
      )}
    </fieldset>
  );
}

/**
 * A select with a label of its own (`for`), so the label text is the label
 * only and not the text of every option. `name` is the id.
 */
export function Select({
  id,
  label,
  options,
  initial,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  options: [string, string][];
  /** The first choice; the user can change it. */
  initial?: string;
  /** A controlled choice, with `onChange`. */
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <select
        id={id}
        name={id}
        disabled={disabled}
        {...(value === undefined ? {} : { value })}
        {...(onChange ? { onChange: (e) => onChange(e.currentTarget.value) } : {})}
      >
        {options.map(([v, text]) => (
          <option value={v} key={v} selected={value === undefined && v === initial}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}
