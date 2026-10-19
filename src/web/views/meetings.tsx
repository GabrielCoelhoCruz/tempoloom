import { useCallback, useEffect, useState } from "preact/hooks";
import { defaultEventSettings, type EventSettings } from "../../shared/event-settings.ts";
import { api } from "../lib/api.ts";
import { duration, formatWhen, hhmm } from "../lib/format.ts";
import { freeName, templateFromUrl } from "../lib/library.ts";
import { useLive } from "../lib/live.ts";
import { LEVEL_NAMES, planNow, zone } from "../lib/state.ts";
import { EventSettingsFields, eventSettingsFrom } from "./event-settings.tsx";
import { describeWeekly, ItemHoursFields, itemHoursFrom } from "./hours-field.tsx";

interface Person {
  email: string;
  class: "user" | "none";
  name: string | null;
  timeZone: string | null;
}

interface Meeting {
  id: string;
  title: string;
  level: number;
  enabled: number;
  ideal_minute: number;
  duration_minutes: number;
  shortest_minutes: number;
  hours_mode: string;
  starting: string | null;
  description: string;
  location: string;
  when_unplaceable: string;
  lead_minutes: number;
  auto_reschedule: string;
  defense: string;
  frequency: Frequency;
  item_hours: string | null;
  event_settings: EventSettings;
  attendees: (Person & { required: boolean })[];
  occurrences: { id: string; key: string; start_ms: number; end_ms: number; locked: number }[];
  problems: {
    demandKey: string;
    status: string;
    reason: string;
    suggestions?: { start: number; end: number }[];
  }[];
  changes: Change[];
  series_event_id: string | null;
}

type Frequency =
  | { period: "daily"; everyDays?: number }
  | { period: "weekly"; everyWeeks: number; idealDays: number[] }
  | ({ period: "monthly"; everyMonths?: number } & (
      | { dayOfMonth: number }
      | { nth: number | "last"; weekday: number }
    ));

const NTH: Record<string, string> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
  last: "last",
};
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "every 2 weeks, ideally Tue", "every month, ideally on day 15". */
function describeFrequency(f: Frequency): string {
  const every = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  if (f.period === "daily") return every(f.everyDays ?? 1, "day");
  if (f.period === "monthly")
    return `${every(f.everyMonths ?? 1, "month")}, ideally on ${
      "nth" in f ? `the ${NTH[f.nth]} ${WEEKDAYS[f.weekday - 1]}` : `day ${f.dayOfMonth}`
    }`;
  return `${every(f.everyWeeks, "week")}, ideally ${f.idealDays.map((d) => DAY_NAMES[d - 1]).join(", ")}`;
}

const EVERY: [string, string][] = [
  ["1", "Every week"],
  ["2", "Every 2 weeks"],
  ["4", "Every 4 weeks"],
  ["daily", "Every day"],
  ["monthly", "Every month"],
  ["custom", "Custom"],
];

/** The "How often" choice that shows a frequency, with the custom count and unit. */
function everyOf(f: Frequency): { every: string; unit: string; n: number } {
  if (f.period === "daily") {
    const n = f.everyDays ?? 1;
    return n === 1 ? { every: "daily", unit: "days", n } : { every: "custom", unit: "days", n };
  }
  if (f.period === "monthly") {
    const n = f.everyMonths ?? 1;
    return n === 1
      ? { every: "monthly", unit: "months", n }
      : { every: "custom", unit: "months", n };
  }
  const n = f.everyWeeks;
  return [1, 2, 4].includes(n)
    ? { every: String(n), unit: "weeks", n }
    : { every: "custom", unit: "weeks", n };
}

/** An adopted series repeats daily or every N weeks on its day (rule 1). */
const seedFrequency = (x: Series): Frequency =>
  x.everyWeeks === "daily"
    ? { period: "daily" }
    : { period: "weekly", everyWeeks: x.everyWeeks, idealDays: [x.idealDay] };

const VISIBILITY: Record<string, string> = {
  calendar_default: "calendar default visibility",
  public: "public",
  private: "private",
};

interface Change {
  id: number;
  occurrence_key: string;
  old_start: number | null;
  new_start: number | null;
  actor: string;
  reason: string;
  detail: string;
}

interface Series {
  key: string;
  calendarId: string;
  seriesId: string;
  title: string;
  description: string;
  location: string;
  attendees: string[];
  start: number;
  end: number;
  idealTime: string;
  idealDay: number;
  everyWeeks: number | "daily";
}

/** MEET-02 rules 9-11: flags that offer other times. */
const FLAGS: Record<string, string> = {
  "budget-reached": "Move limit reached: Tempoloom used today's automatic moves.",
  "policy-none": "No automatic moves: this meeting has a conflict at its time.",
};
const CHANGE_REASONS: Record<string, string> = {
  conflict: "moved for a conflict",
  declined: "declined",
  ruleChanged: "rules changed",
  noFreeSlot: "cancelled, no free time",
  manualMove: "moved by you",
  manualSkip: "skipped by you",
};
const MOVES: [string, string][] = [
  ["none", "No automatic moves"],
  ["conservative", "1 per day"],
  ["moderate", "3 per day"],
  ["aggressive", "5 per day"],
];
const pad2 = (n: number) => String(n).padStart(2, "0");
function localWhen(z: string, t: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: z,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${pad2(Number(get("hour")))}:${get("minute")}`;
}

interface Preview {
  occurrences: { start: number; end: number; conflict: boolean }[];
  problems: { demandKey: string; status: string; reason: string }[];
  moved: number;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFENSE: Record<string, string> = {
  adaptive: "Free until time gets short",
  busy: "Always busy",
  free: "Always free",
};
const REASONS: Record<string, string> = {
  "no-hours-overlap": "no time inside everyone's meeting hours",
  "no-space-fixed": "no free time in the period",
  "no-space-priority": "higher-priority items take all free time",
  "no-hours": "no meeting hours in the period",
  "outside-window": "outside the planning window",
  "too-long-for-hours": "longer than any range of the meeting hours",
};

const emails = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

function PersonLine({ p }: { p: Person }) {
  return p.class === "user" ? (
    <span>
      {p.email}: Tempoloom user, {p.timeZone}
    </span>
  ) : (
    <span class="warning">
      {p.email}: Tempoloom cannot see this person's availability or time zone.
    </span>
  );
}

export function Meetings() {
  const z = zone();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const template = templateFromUrl();
  const preset = template?.kind === "flexible_meeting" ? template.preset : null;
  const [series, setSeries] = useState<Series[]>([]);
  // The recurring meeting the form was filled from (meetings-flexible.md rule 1).
  const [seed, setSeed] = useState<Series | null>(null);
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState("weeks");
  const [hoursMode, setHoursMode] = useState("everyone");
  const [saved, setSaved] = useState(0);
  // The meeting whose rules the form edits (MEET-02 rule 4: a rule change places it again).
  const [editing, setEditing] = useState<Meeting | null>(null);
  const ed = editing;

  const load = useCallback(async () => {
    setMeetings((await api<{ meetings: Meeting[] }>("GET", "/api/meetings")).meetings);
  }, []);
  useEffect(() => void load(), [load]);
  useLive(load);
  const loadSeries = useCallback(async () => {
    const list = (await api<{ series: Series[] }>("GET", "/api/meetings/series")).series;
    setSeries(list);
    return list;
  }, []);
  useEffect(() => {
    // ?adopt=<key> (the new recurring meeting email) fills the form from that series.
    const adopt = new URLSearchParams(location.search).get("adopt");
    void loadSeries().then((list) => {
      const found = adopt ? list.find((x) => x.key === adopt) : undefined;
      if (found) pick(found);
    });
    const t = setInterval(() => void loadSeries(), 10_000);
    return () => clearInterval(t);
  }, [loadSeries]);
  const edit = (m: Meeting) => {
    const init = everyOf(m.frequency);
    setEditing(m);
    setSeed(null);
    setEvery(init.every);
    setUnit(init.unit);
    setHoursMode(m.item_hours ? "itemSpecific" : m.hours_mode);
    setPreview(null);
    void lookup(
      m.attendees
        .filter((a) => a.required)
        .map((a) => a.email)
        .join(", "),
    );
    scrollTo(0, 0);
  };
  const stopEditing = () => {
    setEditing(null);
    setSaved((n) => n + 1);
    setEvery("1");
    setHoursMode("everyone");
    setPeople([]);
  };
  const everyInit = ed
    ? everyOf(ed.frequency).every
    : seed
      ? everyOf(seedFrequency(seed)).every
      : preset?.everyWeeks === 2
        ? "2"
        : "1";
  const fq = ed?.frequency ?? (seed ? seedFrequency(seed) : undefined);
  // A series repeats every day or every N weeks from its first instance (rules 1, 10).
  const forSeries = seed !== null || Boolean(ed?.series_event_id);
  const shownUnit = forSeries ? "weeks" : unit;
  const pick = (x: Series | null) => {
    const init = x ? everyOf(seedFrequency(x)) : { every: "1", unit: "weeks" };
    setSeed(x);
    setEvery(init.every);
    setUnit(init.unit);
    setPreview(null);
    if (x) void lookup(x.attendees.join(", "));
    else setPeople([]);
  };

  const fail = (err: unknown) => {
    const body = (err as { body?: { issues?: { message: string }[] } }).body;
    setError(body?.issues?.[0]?.message ?? (err instanceof Error ? err.message : String(err)));
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const lookup = async (text: string) => {
    const list = await Promise.all(
      emails(text).map((email) =>
        api<Person>("GET", `/api/meetings/person?email=${encodeURIComponent(email)}`).catch(
          () => null,
        ),
      ),
    );
    setPeople(list.filter((p): p is Person => p !== null));
  };

  const body = (form: HTMLFormElement) => {
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const days = f.getAll("days").map(Number);
    const n = Number(f.get("everyN") || 1);
    const monthDay = Number(f.get("dayOfMonth") || 1);
    const nth = text("nth");
    const onDay = nth
      ? { nth: nth === "last" ? "last" : Number(nth), weekday: Number(f.get("weekday")) }
      : { dayOfMonth: monthDay };
    const how = text("every") === "custom" ? text("everyUnit") : text("every");
    const frequency =
      how === "daily" || how === "days"
        ? { period: "daily", everyDays: how === "days" ? n : 1 }
        : how === "monthly" || how === "months"
          ? { period: "monthly", everyMonths: how === "months" ? n : 1, ...onDay }
          : {
              period: "weekly",
              everyWeeks: how === "weeks" ? n : Number(how),
              idealDays: days.length ? days : [2],
            };
    return {
      title: text("title"),
      attendees: [
        ...emails(text("guests")).map((email) => ({ email, required: true })),
        ...emails(text("optional")).map((email) => ({ email, required: false })),
      ],
      frequency,
      idealTime: text("idealTime"),
      durationMinutes: Number(f.get("duration")),
      shortestMinutes: Number(f.get("shortest") || f.get("duration")),
      hoursMode: text("hoursMode"),
      ...(text("hoursMode") === "itemSpecific" ? { itemHours: itemHoursFrom(f) } : {}),
      eventSettings: eventSettingsFrom(f),
      level: Number(f.get("level")),
      defense: text("defense"),
      whenUnplaceable: text("whenUnplaceable"),
      leadHours: Number(f.get("leadHours")),
      autoReschedule: text("autoReschedule"),
      starting: text("starting") || null,
      description: text("description"),
      location: text("location"),
      ...(seed ? { series: { calendarId: seed.calendarId, seriesId: seed.seriesId } } : {}),
    };
  };

  return (
    <div class="page" data-testid="meetings-page">
      <h1>Meetings</h1>
      <p>
        A flexible meeting repeats with the people you invite. Tempoloom finds a time that suits
        everyone and moves it when something gets in the way.
      </p>
      <form
        class="form"
        data-testid="meeting-form"
        // A new key after each save draws a fresh form: reset() would pick the first
        // option of each select, because Preact sets `selected` as a property only.
        key={
          ed
            ? `edit-${ed.id}`
            : seed
              ? `series-${seed.key}`
              : template
                ? `${template.slug}-${meetings.length}`
                : `new-${saved}`
        }
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget as HTMLFormElement;
          void act(async () => {
            if (ed) {
              await api("PUT", `/api/meetings/${ed.id}`, body(form));
              stopEditing();
              return;
            }
            await api("POST", "/api/meetings", body(form));
            setSaved((n) => n + 1);
            setPeople([]);
            setPreview(null);
            setSeed(null);
            setEvery("1");
            setHoursMode("everyone");
            await loadSeries();
          });
        }}
      >
        {ed && <p class="wide status">Editing “{ed.title}”</p>}
        <label class="wide" hidden={ed !== null}>
          From an existing meeting
          <select
            name="series"
            value={seed?.key ?? ""}
            onChange={(e) => pick(series.find((x) => x.key === e.currentTarget.value) ?? null)}
          >
            <option value="">A new meeting</option>
            {series.map((x) => (
              <option value={x.key} key={x.key}>
                {x.title}
              </option>
            ))}
          </select>
        </label>
        <label class="wide">
          Title
          <input
            name="title"
            required
            maxLength={255}
            defaultValue={
              ed
                ? ed.title
                : seed
                  ? seed.title
                  : template
                    ? freeName(
                        template.name,
                        meetings.map((m) => m.title),
                      )
                    : ""
            }
          />
        </label>
        <label class="wide">
          Guests (comma list)
          <input
            name="guests"
            required
            placeholder="ana@example.com, ben@example.com"
            defaultValue={
              ed
                ? ed.attendees
                    .filter((a) => a.required)
                    .map((a) => a.email)
                    .join(", ")
                : seed
                  ? seed.attendees.join(", ")
                  : ""
            }
            onChange={(e) => void lookup(e.currentTarget.value)}
          />
        </label>
        {people.length > 0 && (
          <ul class="wide meta" data-testid="attendee-info">
            {people.map((p) => (
              <li key={p.email}>
                <PersonLine p={p} />
              </li>
            ))}
          </ul>
        )}
        <label class="wide">
          Optional guests (comma list)
          <input
            name="optional"
            defaultValue={
              ed
                ? ed.attendees
                    .filter((a) => !a.required)
                    .map((a) => a.email)
                    .join(", ")
                : ""
            }
          />
        </label>
        <label>
          How often
          <select name="every" onChange={(e) => setEvery(e.currentTarget.value)}>
            {EVERY.filter(([v]) => !forSeries || v !== "monthly").map(([v, l]) => (
              <option value={v} key={v} selected={v === everyInit}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {every === "custom" && (
          <>
            <label>
              Repeat every
              <input
                name="everyN"
                type="number"
                min={1}
                max={52}
                defaultValue={String(fq ? everyOf(fq).n : 2)}
                required
              />
            </label>
            <label>
              Unit
              <select
                name="everyUnit"
                value={shownUnit}
                onChange={(e) => setUnit(e.currentTarget.value)}
              >
                {!forSeries && <option value="days">Days</option>}
                <option value="weeks">Weeks</option>
                {!forSeries && <option value="months">Months</option>}
              </select>
            </label>
          </>
        )}
        {(every === "monthly" || (every === "custom" && shownUnit === "months")) && (
          <>
            <label>
              Day of the month
              <input
                name="dayOfMonth"
                type="number"
                min={1}
                max={31}
                defaultValue={String(fq && "dayOfMonth" in fq ? fq.dayOfMonth : 1)}
              />
            </label>
            <label>
              Or on the
              <select name="nth">
                <option value="">Not used</option>
                {Object.entries(NTH).map(([v, l]) => (
                  <option value={v} key={v} selected={fq && "nth" in fq && String(fq.nth) === v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Weekday
              <select name="weekday">
                {WEEKDAYS.map((d, i) => (
                  <option
                    value={i + 1}
                    key={d}
                    selected={fq && "weekday" in fq && fq.weekday === i + 1}
                  >
                    {d}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Ideal time
          <input
            name="idealTime"
            type="time"
            step={900}
            defaultValue={ed ? hhmm(ed.ideal_minute) : (seed?.idealTime ?? "10:00")}
          />
        </label>
        <label>
          Duration (minutes)
          <input
            name="duration"
            type="number"
            min={5}
            max={480}
            step={5}
            defaultValue={String(
              ed
                ? ed.duration_minutes
                : seed
                  ? Math.max(5, Math.round((seed.end - seed.start) / 300_000) * 5)
                  : (preset?.durationMinutes ?? 30),
            )}
          />
        </label>
        <label>
          Can shorten to (minutes)
          <input
            name="shortest"
            type="number"
            min={5}
            max={480}
            step={5}
            defaultValue={
              ed && ed.shortest_minutes < ed.duration_minutes ? String(ed.shortest_minutes) : ""
            }
          />
        </label>
        <label>
          Priority
          <select name="level">
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l} selected={l === (ed?.level ?? preset?.level ?? 2)}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hours
          <select
            name="hoursMode"
            value={hoursMode}
            onChange={(e) => setHoursMode(e.currentTarget.value)}
          >
            <option value="everyone">Everyone's meeting hours</option>
            <option value="organizer">My meeting hours only</option>
            <option value="itemSpecific">Item-specific hours</option>
          </select>
        </label>
        {hoursMode === "itemSpecific" && (
          <ItemHoursFields initial={ed?.item_hours ? JSON.parse(ed.item_hours) : undefined} />
        )}
        <label>
          Show as
          <select name="defense">
            {Object.entries(DEFENSE).map(([v, l]) => (
              <option value={v} key={v} selected={v === ed?.defense}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          When there is no time
          <select name="whenUnplaceable">
            <option value="keep_as_conflict">Keep it and mark the conflict</option>
            <option value="remove" selected={ed?.when_unplaceable === "remove"}>
              Remove it for that period
            </option>
          </select>
        </label>
        <label>
          Move notice (hours)
          <input
            name="leadHours"
            type="number"
            min={0}
            max={168}
            defaultValue={String(ed ? ed.lead_minutes / 60 : 12)}
          />
        </label>
        <label>
          Automatic moves
          <select name="autoReschedule">
            {MOVES.map(([v, l]) => (
              <option value={v} key={v} selected={v === (ed?.auto_reschedule ?? "moderate")}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {!forSeries && (
          <label>
            Starting
            <input name="starting" type="date" defaultValue={ed?.starting ?? ""} />
          </label>
        )}
        <label>
          Location
          <input
            name="location"
            maxLength={500}
            defaultValue={ed ? ed.location : (seed?.location ?? "")}
          />
        </label>
        <fieldset class="wide days">
          <legend>Ideal days (weekly)</legend>
          {DAY_NAMES.map((n, i) => (
            <label key={n} class="inline">
              <input
                type="checkbox"
                name="days"
                value={i + 1}
                defaultChecked={
                  fq?.period === "weekly"
                    ? fq.idealDays.includes(i + 1)
                    : seed
                      ? i === seed.idealDay - 1
                      : i === 1
                }
              />
              {n}
            </label>
          ))}
        </fieldset>
        <label class="wide">
          Description
          <textarea
            name="description"
            rows={2}
            maxLength={8000}
            defaultValue={ed ? ed.description : (seed?.description ?? "")}
          />
        </label>
        <EventSettingsFields
          kind="meeting"
          initial={ed?.event_settings ?? defaultEventSettings("meeting")}
          editing={ed !== null}
        />
        <div class="actions wide">
          <button
            type="button"
            onClick={(e) => {
              const form = (e.currentTarget as HTMLButtonElement).form;
              if (!form?.reportValidity()) return;
              setError(null);
              api<Preview>(
                "POST",
                `/api/meetings/preview${ed ? `?id=${encodeURIComponent(ed.id)}` : ""}`,
                body(form),
              ).then(setPreview, fail);
            }}
          >
            Preview
          </button>
          <button type="submit" class="primary">
            {ed ? "Save meeting" : "Add meeting"}
          </button>
          {ed && (
            <button type="button" onClick={stopEditing}>
              Cancel
            </button>
          )}
        </div>
      </form>
      {preview && (
        <div class="list" data-testid="meeting-preview">
          {preview.occurrences.map((o) => (
            <div class="row" key={o.start}>
              <span>
                {formatWhen(z, o.start)} to {formatWhen(z, o.end).slice(-5)}
                {o.conflict ? " · conflict" : ""}
              </span>
            </div>
          ))}
          {preview.problems.map((p) => (
            <div class="row" key={p.demandKey}>
              <span class="warning">Not placed: {REASONS[p.reason] ?? p.reason}</span>
            </div>
          ))}
          <p class="meta">{preview.moved} other events move to make room.</p>
        </div>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {[1, 2, 3, 4].map((level) => {
        const group = meetings.filter((m) => m.level === level);
        if (group.length === 0) return null;
        return (
          <section key={level}>
            <h2>{LEVEL_NAMES[level]}</h2>
            <div class="list" data-testid="meeting-list">
              {group.map((m) => (
                <div class="row" key={m.id} data-testid="meeting-row" data-meeting-title={m.title}>
                  <div>
                    <div>
                      {m.title} {m.enabled ? null : <span class="badge">off</span>}
                    </div>
                    <div class="meta">
                      {describeFrequency(m.frequency)} at {hhmm(m.ideal_minute)} ·{" "}
                      {duration(m.duration_minutes)}
                      {m.shortest_minutes < m.duration_minutes
                        ? ` (or ${duration(m.shortest_minutes)})`
                        : ""}{" "}
                      · {DEFENSE[m.defense] ?? m.defense}
                    </div>
                    <div class="meta" data-testid="meeting-settings">
                      {m.item_hours
                        ? `Item-specific hours: ${describeWeekly(JSON.parse(m.item_hours))}`
                        : m.hours_mode === "organizer"
                          ? "My meeting hours only"
                          : "Everyone's meeting hours"}
                      {m.starting ? ` · starting ${m.starting}` : ""} ·{" "}
                      {VISIBILITY[m.event_settings.visibility]} ·{" "}
                      {m.event_settings.reminders === "default"
                        ? "calendar default reminders"
                        : m.event_settings.reminders === "none"
                          ? "no reminders"
                          : `reminder ${m.event_settings.reminders.join(", ")} min before`}
                      {m.event_settings.calendarId ? " · own calendar" : ""}
                    </div>
                    <ul class="meta" data-testid="meeting-attendees">
                      {m.attendees.map((a) => (
                        <li key={a.email}>
                          <PersonLine p={a} />
                          {a.required ? "" : " (optional)"}
                        </li>
                      ))}
                    </ul>
                    <ul class="meta" data-testid="meeting-occurrences">
                      {m.occurrences.slice(0, 4).map((o) => (
                        <li key={o.key}>
                          {formatWhen(z, o.start_ms)} to {formatWhen(z, o.end_ms).slice(-5)}
                          {o.locked ? " · locked" : ""}
                        </li>
                      ))}
                      {m.problems
                        .filter((p) => !FLAGS[p.reason])
                        .map((p) => (
                          <li key={p.demandKey} class="warning">
                            {p.status === "conflict" ? "Conflict" : "Not placed"}:{" "}
                            {REASONS[p.reason] ?? p.reason}
                          </li>
                        ))}
                    </ul>
                    {m.problems
                      .filter((p) => FLAGS[p.reason])
                      .map((p) => {
                        const occurrence = m.occurrences.find((o) => o.key === p.demandKey);
                        return (
                          <div key={p.demandKey} class="warning" data-testid="meeting-flag">
                            {occurrence ? `${localWhen(z, occurrence.start_ms)}: ` : ""}
                            {FLAGS[p.reason]}
                            <div class="actions">
                              {occurrence &&
                                (p.suggestions ?? []).map((t) => (
                                  <button
                                    type="button"
                                    key={t.start}
                                    data-testid="suggestion"
                                    onClick={() =>
                                      void act(() =>
                                        api("POST", `/api/meetings/${m.id}/move`, {
                                          eventId: occurrence.id,
                                          start: t.start,
                                        }),
                                      )
                                    }
                                  >
                                    Move to {localWhen(z, t.start)}
                                  </button>
                                ))}
                            </div>
                          </div>
                        );
                      })}
                    {m.changes.length > 0 && (
                      <details class="meta" open>
                        <summary>Changes</summary>
                        <ul data-testid="meeting-changes">
                          {m.changes.map((ch) => (
                            <li key={ch.id} data-testid="change" data-reason={ch.reason}>
                              {ch.old_start !== null ? localWhen(z, ch.old_start) : ""} →{" "}
                              {ch.new_start !== null ? localWhen(z, ch.new_start) : "no new time"} ·{" "}
                              {CHANGE_REASONS[ch.reason] ?? ch.reason} · by {ch.detail || ch.actor}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div class="actions">
                    <button type="button" onClick={() => edit(m)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void act(() =>
                          api("POST", `/api/meetings/${m.id}/enabled`, { enabled: !m.enabled }),
                        )
                      }
                    >
                      {m.enabled ? "Turn off" : "Turn on"}
                    </button>
                    <button
                      type="button"
                      class="danger"
                      onClick={() => void act(() => api("DELETE", `/api/meetings/${m.id}`))}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {meetings.length === 0 && <p class="status">No meetings yet.</p>}
    </div>
  );
}
