// Focus time options (mode, auto-decline, task search) and the meeting
// overload automation (docs/specs/focus-time.md rules 1-16, 23, 24).
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { templateFromUrl } from "../lib/library.ts";
import { planNow } from "../lib/state.ts";
import { TaskSearchPicker } from "./task-search-picker.tsx";

interface FocusRow {
  id: string;
  title: string;
  mode: "proactive" | "reactive";
  decline_enabled: number;
  decline_message: string;
  task_search_id: string | null;
}

const DEFAULT_MESSAGE = "Declined automatically: this time is protected for focus.";

function FocusOptions({ focus }: { focus: FocusRow }) {
  const [mode, setMode] = useState(focus.mode);
  const [decline, setDecline] = useState(focus.decline_enabled === 1);
  const [message, setMessage] = useState(focus.decline_message);
  const [searchId, setSearchId] = useState(focus.task_search_id);
  const [status, setStatus] = useState<string | null>(null);
  const save = async () => {
    setStatus(null);
    try {
      await api("PATCH", `/api/focus/${focus.id}/options`, {
        mode,
        autoDecline: { enabled: decline, message },
        taskSearchId: searchId,
      });
      await planNow();
      setStatus("Saved");
    } catch {
      setStatus("Could not save the focus options.");
    }
  };
  return (
    <div class="form" data-testid="focus-options" data-focus-options={focus.title}>
      <label>
        Mode
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as FocusRow["mode"])}>
          <option value="proactive">Proactive</option>
          <option value="reactive">Reactive</option>
        </select>
      </label>
      <p class="meta wide">
        Proactive protects the goal early. Reactive waits while the week has more free time than the
        goal still needs, then protects what is left.
      </p>
      <label class="inline wide">
        <input
          type="checkbox"
          checked={decline}
          onChange={(e) => setDecline(e.currentTarget.checked)}
        />
        Decline invitations that overlap focus time
      </label>
      <label class="wide">
        Decline message
        <input
          value={message}
          maxLength={500}
          placeholder={DEFAULT_MESSAGE}
          onInput={(e) => setMessage(e.currentTarget.value)}
        />
      </label>
      {decline && <p class="meta warning wide">Tempoloom sends these declines to other people.</p>}
      <div class="wide">
        <TaskSearchPicker value={searchId} onChange={setSearchId} />
      </div>
      <button type="button" class="primary" onClick={() => void save()}>
        Save focus options
      </button>
      {status && (
        <p class="status" data-testid="focus-options-message">
          {status}
        </p>
      )}
    </div>
  );
}

/** Options of every focus time automation of the user. */
export function FocusOptionsList() {
  const [rows, setRows] = useState<FocusRow[]>([]);
  useEffect(() => {
    void api<{ focus: FocusRow[] }>("GET", "/api/focus").then((r) => setRows(r.focus));
  }, []);
  return (
    <>
      {rows.map((f) => (
        <FocusOptions key={f.id} focus={f} />
      ))}
    </>
  );
}

interface Overload {
  id: string;
  title: string;
  enabled: number;
  daily_max_minutes: number | null;
  weekly_max_minutes: number | null;
  heavy_day_minutes: number | null;
  min_block_minutes: number;
  decline_enabled: number;
  decline_message: string;
  hours_set_id: string;
  task_search_id: string | null;
}

const h = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;

function summary(o: Overload): string {
  return [
    o.daily_max_minutes !== null ? `${h(o.daily_max_minutes)} a day` : null,
    o.weekly_max_minutes !== null ? `${h(o.weekly_max_minutes)} a week` : null,
    o.heavy_day_minutes !== null ? `after a day with ${h(o.heavy_day_minutes)} of meetings` : null,
    `blocks of ${duration(o.min_block_minutes)} or more`,
    o.decline_enabled ? `declines with “${o.decline_message || DEFAULT_MESSAGE}”` : null,
    o.enabled ? null : "off",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Rules 11-16: caps meeting hours per day or week and protects the rest as focus time. */
export function MeetingOverloadSection() {
  const template = templateFromUrl();
  const preset = template?.kind === "meeting_overload" ? template.preset : null;
  const [rows, setRows] = useState<Overload[]>([]);
  const [hours, setHours] = useState<{ id: string; kind: string; name: string }[]>([]);
  const [decline, setDecline] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [hoursChoice, setHoursChoice] = useState("");
  /** The overload whose settings the form changes; null: the form adds one. */
  const [editing, setEditing] = useState<Overload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);

  const startEdit = (o: Overload, kinds: { id: string; kind: string }[]) => {
    setEditing(o);
    setDecline(o.decline_enabled === 1);
    setSearchId(o.task_search_id);
    setHoursChoice(
      kinds.find((x) => x.id === o.hours_set_id)?.kind === "work" ? "" : o.hours_set_id,
    );
    section.current?.scrollIntoView();
  };
  const stopEdit = () => {
    setEditing(null);
    setDecline(false);
    setSearchId(null);
    setHoursChoice("");
    const url = new URL(location.href);
    url.searchParams.delete("overload");
    history.replaceState(null, "", url.pathname + url.search);
  };

  // The automation list's Edit opens /settings?overload=<id> (automations-overview.md rule 11).
  const opened = useRef(false);
  const load = useCallback(async () => {
    const [o, hs] = await Promise.all([
      api<{ overloads: Overload[] }>("GET", "/api/meeting-overloads"),
      api<{ hours: { id: string; kind: string; name: string }[] }>("GET", "/api/hours"),
    ]);
    setRows(o.overloads);
    setHours(hs.hours);
    if (!opened.current) {
      opened.current = true;
      const id = new URLSearchParams(location.search).get("overload");
      const row = o.overloads.find((x) => x.id === id);
      if (row) startEdit(row, hs.hours);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
      await load();
    } catch (err) {
      const b = (err as { body?: { issues?: { message: string }[] } }).body;
      setError(b?.issues?.[0]?.message ?? "Could not save.");
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const minutes = (k: string) => {
      const v = String(f.get(k) ?? "").trim();
      return v === "" ? null : Math.round(Number(v) * 60);
    };
    // "Work hours" is the default for a new one; a change back to it names the set.
    const chosen =
      String(f.get("hoursSetId") ?? "") ||
      (editing ? hours.find((x) => x.kind === "work")?.id : undefined);
    const body = {
      title: String(f.get("title") ?? "").trim(),
      dailyMaxMinutes: minutes("daily"),
      weeklyMaxMinutes: minutes("weekly"),
      heavyDayMinutes: minutes("heavy"),
      minBlockMinutes: Number(f.get("minBlock")),
      ...(chosen ? { hoursSetId: chosen } : {}),
      autoDecline: { enabled: decline, message: String(f.get("message") ?? "").trim() },
      taskSearchId: searchId,
    };
    const id = editing?.id;
    void act(async () => {
      if (!id) return api("POST", "/api/meeting-overloads", body);
      await api("PATCH", `/api/meeting-overloads/${id}`, body);
      stopEdit();
    });
  };
  const hoursText = (m: number | null | undefined) => (m ? String(m / 60) : "");

  return (
    <section data-testid="overload-section" ref={section}>
      <h2>Meeting overload</h2>
      <p class="status">
        When meetings reach a daily or weekly limit, the rest of that time becomes focus time.
      </p>
      <form
        class="form"
        data-testid="overload-form"
        onSubmit={submit}
        key={editing?.id ?? template?.slug ?? "new"}
      >
        {editing && <p class="status wide">Changing {editing.title}</p>}
        <label class="wide">
          Title
          <input
            name="title"
            required
            maxLength={255}
            defaultValue={
              editing
                ? editing.title
                : template?.kind === "meeting_overload"
                  ? template.name
                  : "Meeting overload"
            }
          />
        </label>
        <label>
          Daily meeting limit (hours)
          <input
            name="daily"
            type="number"
            min={0.5}
            max={24}
            step={0.5}
            defaultValue={
              editing
                ? hoursText(editing.daily_max_minutes)
                : preset?.dailyMaxHours
                  ? String(preset.dailyMaxHours)
                  : ""
            }
          />
        </label>
        <label>
          Weekly meeting limit (hours)
          <input
            name="weekly"
            type="number"
            min={0.5}
            max={168}
            step={0.5}
            defaultValue={
              editing
                ? hoursText(editing.weekly_max_minutes)
                : preset?.weeklyMaxHours
                  ? String(preset.weeklyMaxHours)
                  : ""
            }
          />
        </label>
        <label>
          Only after a day with this many meeting hours
          <input
            name="heavy"
            type="number"
            min={0.5}
            max={24}
            step={0.5}
            defaultValue={
              editing
                ? hoursText(editing.heavy_day_minutes)
                : preset?.heavyDayHours
                  ? String(preset.heavyDayHours)
                  : ""
            }
          />
        </label>
        <label>
          Shortest focus block (minutes)
          <input
            name="minBlock"
            type="number"
            min={15}
            max={480}
            step={15}
            defaultValue={String(editing?.min_block_minutes ?? 30)}
          />
        </label>
        <label>
          Hours
          <select
            name="hoursSetId"
            value={hoursChoice}
            onChange={(e) => setHoursChoice(e.currentTarget.value)}
          >
            <option value="">Work hours</option>
            {hours
              .filter((x) => x.kind !== "work")
              .map((x) => (
                <option value={x.id} key={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </label>
        <label class="inline wide">
          <input
            type="checkbox"
            checked={decline}
            onChange={(e) => setDecline(e.currentTarget.checked)}
          />
          Decline invitations that overlap the protected time
        </label>
        <label class="wide">
          Decline message
          <input
            name="message"
            maxLength={500}
            placeholder={DEFAULT_MESSAGE}
            defaultValue={editing?.decline_message ?? ""}
          />
        </label>
        {decline && (
          <p class="meta warning wide">Tempoloom sends these declines to other people.</p>
        )}
        <div class="wide">
          <TaskSearchPicker value={searchId} onChange={setSearchId} />
        </div>
        <div class="actions wide">
          <button type="submit" class="primary">
            {editing ? "Save changes" : "Add meeting overload"}
          </button>
          {editing && (
            <button type="button" onClick={stopEdit}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="list" data-testid="overload-list">
        {rows.map((o) => (
          <div class="row" key={o.id} data-overload-title={o.title}>
            <div>
              <div>{o.title}</div>
              <div class="meta">{summary(o)}</div>
            </div>
            <div class="actions">
              <button type="button" onClick={() => startEdit(o, hours)}>
                Edit
              </button>
              <button
                type="button"
                onClick={() =>
                  void act(() =>
                    api("PATCH", `/api/meeting-overloads/${o.id}`, { enabled: !o.enabled }),
                  )
                }
              >
                {o.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                type="button"
                class="danger"
                onClick={() =>
                  void act(async () => {
                    await api("DELETE", `/api/meeting-overloads/${o.id}`);
                    if (editing?.id === o.id) stopEdit();
                  })
                }
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
