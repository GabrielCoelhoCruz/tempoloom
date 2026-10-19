import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { duration, formatWhen, hhmm } from "../lib/format.ts";
import { freeName, templateFromUrl } from "../lib/library.ts";
import { useLive } from "../lib/live.ts";
import { LEVEL_NAMES, planNow, zone } from "../lib/state.ts";

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
  defense: string;
  frequency: { period: "daily" } | { period: "weekly"; everyWeeks: number; idealDays: number[] };
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
  const pick = (x: Series | null) => {
    setSeed(x);
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
    const every = text("every");
    const days = f.getAll("days").map(Number);
    return {
      title: text("title"),
      attendees: [
        ...emails(text("guests")).map((email) => ({ email, required: true })),
        ...emails(text("optional")).map((email) => ({ email, required: false })),
      ],
      frequency:
        every === "daily"
          ? { period: "daily" }
          : { period: "weekly", everyWeeks: Number(every), idealDays: days.length ? days : [2] },
      idealTime: text("idealTime"),
      durationMinutes: Number(f.get("duration")),
      shortestMinutes: Number(f.get("shortest") || f.get("duration")),
      hoursMode: text("hoursMode"),
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
        key={seed ? `series-${seed.key}` : template ? `${template.slug}-${meetings.length}` : "new"}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget as HTMLFormElement;
          void act(async () => {
            await api("POST", "/api/meetings", body(form));
            form.reset();
            setPeople([]);
            setPreview(null);
            setSeed(null);
            await loadSeries();
          });
        }}
      >
        <label class="wide">
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
              seed
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
            defaultValue={seed ? seed.attendees.join(", ") : ""}
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
          <input name="optional" />
        </label>
        <label>
          How often
          <select name="every">
            <option value="1">Every week</option>
            <option value="2" selected={seed ? seed.everyWeeks === 2 : preset?.everyWeeks === 2}>
              Every 2 weeks
            </option>
            <option value="4" selected={seed?.everyWeeks === 4}>
              Every 4 weeks
            </option>
            <option value="daily" selected={seed?.everyWeeks === "daily"}>
              Every day
            </option>
          </select>
        </label>
        <label>
          Ideal time
          <input
            name="idealTime"
            type="time"
            step={900}
            defaultValue={seed?.idealTime ?? "10:00"}
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
              seed
                ? Math.max(5, Math.round((seed.end - seed.start) / 300_000) * 5)
                : (preset?.durationMinutes ?? 30),
            )}
          />
        </label>
        <label>
          Can shorten to (minutes)
          <input name="shortest" type="number" min={5} max={480} step={5} />
        </label>
        <label>
          Priority
          <select name="level">
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l} selected={l === (preset?.level ?? 2)}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hours
          <select name="hoursMode">
            <option value="everyone">Everyone's meeting hours</option>
            <option value="organizer">My meeting hours only</option>
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
          When there is no time
          <select name="whenUnplaceable">
            <option value="keep_as_conflict">Keep it and mark the conflict</option>
            <option value="remove">Remove it for that period</option>
          </select>
        </label>
        <label>
          Move notice (hours)
          <input name="leadHours" type="number" min={0} max={168} defaultValue="12" />
        </label>
        <label>
          Automatic moves
          <select name="autoReschedule">
            {MOVES.map(([v, l]) => (
              <option value={v} key={v} selected={v === "moderate"}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Starting
          <input name="starting" type="date" />
        </label>
        <label>
          Location
          <input name="location" maxLength={500} defaultValue={seed?.location ?? ""} />
        </label>
        <fieldset class="wide days">
          <legend>Ideal days (weekly)</legend>
          {DAY_NAMES.map((n, i) => (
            <label key={n} class="inline">
              <input
                type="checkbox"
                name="days"
                value={i + 1}
                defaultChecked={seed ? i === seed.idealDay - 1 : i === 1}
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
            defaultValue={seed?.description ?? ""}
          />
        </label>
        <div class="actions wide">
          <button
            type="button"
            onClick={(e) => {
              const form = (e.currentTarget as HTMLButtonElement).form;
              if (!form?.reportValidity()) return;
              setError(null);
              api<Preview>("POST", "/api/meetings/preview", body(form)).then(setPreview, fail);
            }}
          >
            Preview
          </button>
          <button type="submit" class="primary">
            Add meeting
          </button>
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
                      {m.frequency.period === "daily"
                        ? "every day"
                        : `every ${m.frequency.everyWeeks === 1 ? "week" : `${m.frequency.everyWeeks} weeks`}, ideally ${m.frequency.idealDays.map((d) => DAY_NAMES[d - 1]).join(", ")}`}{" "}
                      at {hhmm(m.ideal_minute)} · {duration(m.duration_minutes)}
                      {m.shortest_minutes < m.duration_minutes
                        ? ` (or ${duration(m.shortest_minutes)})`
                        : ""}{" "}
                      · {DEFENSE[m.defense] ?? m.defense}
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
