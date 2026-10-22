// The organizer's edits of a whole meeting series in the calendar
// (docs/specs/meetings-flexible-rescheduling.md rules 18 and 22): "all events"
// changes the series master, "this and following events" ends the series and
// starts a new one. Runs after a pull, before declines and calendar edits are
// read, so the instances that a series edit changed count neither as moved by
// hand (a lock) nor as deleted (a skip).
import type { MeetingFrequency } from "../../scheduler/model.ts";
import { type LocalDate, MINUTE, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import type { SeriesFacts } from "../providers/types.ts";
import { getSettings } from "../settings.ts";
import { homeZone, planningZone } from "../travel.ts";
import { stripMarker } from "./markers.ts";
import { logChange, periodOf } from "./meeting-log.ts";
import type { MeetingRow } from "./meetings.ts";
import type { ManagedRow } from "./push.ts";
import { type Baseline, BYDAY, formKey, instanceDate } from "./series.ts";

interface Instance {
  event_id: string;
  start_ms: number;
  end_ms: number;
  summary: string;
  etag: string | null;
  series: string;
}

const factsOf = (json: string): SeriesFacts | null =>
  json ? (JSON.parse(json) as SeriesFacts | null) : null;

/** The fields of a master that a series edit changes. */
const ruleKey = (f: SeriesFacts | null) =>
  f
    ? JSON.stringify([
        f.start,
        f.end,
        f.rrule,
        f.summary,
        [...f.attendees].sort(),
        [...f.optional].sort(),
      ])
    : "";

/**
 * The meeting frequency of a series rule (rule 22, Proposed: a recurrence
 * change sets a new frequency), or null when the rule is not one a meeting
 * can follow; then the frequency stays.
 */
export function frequencyOf(rrule: string, date: LocalDate): MeetingFrequency | null {
  const parts = new Map(rrule.split(";").map((p) => p.split("=") as [string, string]));
  const every = Number(parts.get("INTERVAL") ?? 1);
  if (!Number.isInteger(every) || every < 1 || every > 52) return null;
  const days = (parts.get("BYDAY") ?? "").split(",").filter(Boolean);
  switch (parts.get("FREQ")) {
    case "DAILY":
      return days.length > 0 ? null : { period: "daily", everyDays: every };
    case "WEEKLY": {
      const ideal = days.length ? days.map((d) => BYDAY.indexOf(d) + 1) : [weekdayOf(date)];
      if (ideal.some((d) => d < 1)) return null;
      // One instance per period: a rule on two days a week is not a meeting's.
      if (ideal.length !== 1) return null;
      return { period: "weekly", everyWeeks: every, idealDays: ideal };
    }
    case "MONTHLY": {
      const nth = /^(-1|[1-5])(MO|TU|WE|TH|FR|SA|SU)$/.exec(days[0] ?? "");
      if (days.length === 1 && nth)
        return {
          period: "monthly",
          everyMonths: every,
          nth: nth[1] === "-1" ? "last" : (Number(nth[1]) as 1 | 2 | 3 | 4 | 5),
          weekday: BYDAY.indexOf(nth[2] ?? "") + 1,
        };
      const monthDays = (parts.get("BYMONTHDAY") ?? "").split(",").map(Number);
      const last = Math.max(...monthDays);
      if (days.length === 0 && monthDays.every((d) => d >= 1 && d <= 31))
        return { period: "monthly", everyMonths: every, dayOfMonth: last };
      return null;
    }
    default:
      return null;
  }
}

/**
 * The form key (series.ts formKey) of the master after a series edit: each
 * rule field the edit changed (meeting row `m` before, `changed` after) has
 * its new value; the others keep the value last written to the master.
 */
function masterForm(written: string, m: MeetingRow, changed: MeetingRow): string {
  const [frequency, starting, duration, ideal] = JSON.parse(written) as [
    string,
    string | null,
    number,
    number,
  ];
  return formKey({
    ...changed,
    frequency: changed.frequency !== m.frequency ? changed.frequency : frequency,
    starting: changed.starting !== m.starting ? changed.starting : starting,
    duration_minutes:
      changed.duration_minutes !== m.duration_minutes ? changed.duration_minutes : duration,
    ideal_minute: changed.ideal_minute !== m.ideal_minute ? changed.ideal_minute : ideal,
  });
}

/** The repeat unit and count of a frequency: a change of either gives other periods. */
const cadence = (f: MeetingFrequency) =>
  f.period === "weekly"
    ? `w${f.everyWeeks}`
    : f.period === "daily"
      ? `d${f.everyDays ?? 1}`
      : `m${f.everyMonths ?? 1}`;

/** Reads the series edits of the user's meetings on these calendars. */
export function readSeriesEdits(db: Db, userId: string, calendarIds: string[], now: number): void {
  const calendars = new Set(calendarIds);
  const meetings = all<MeetingRow>(
    db,
    "SELECT * FROM meetings WHERE user_id = ? AND enabled = 1 AND series_event_id IS NOT NULL",
    userId,
  ).filter((m) => m.series_calendar_id && calendars.has(m.series_calendar_id));
  if (meetings.length === 0) return;
  const settings = getSettings(db, userId);
  const zone = planningZone(db, userId);
  const self = new Set(
    all<{ email: string }>(
      db,
      "SELECT email FROM users WHERE id = ? UNION SELECT email FROM accounts WHERE user_id = ?",
      userId,
      userId,
    ).map((r) => r.email.toLowerCase()),
  );
  tx(db, () => {
    for (const m of meetings) readOne(db, userId, m, now, zone, settings, self);
  });
}

function readOne(
  db: Db,
  userId: string,
  m: MeetingRow,
  now: number,
  zone: string,
  settings: ReturnType<typeof getSettings>,
  self: Set<string>,
): void {
  const calendarId = m.series_calendar_id as string;
  const instancesOf = (seriesId: string) =>
    all<Instance>(
      db,
      `SELECT event_id, start_ms, end_ms, summary, etag, series FROM events
       WHERE calendar_id = ? AND recurring_id = ? AND series <> '' ORDER BY start_ms`,
      calendarId,
      seriesId,
    );
  const current = instancesOf(m.series_event_id as string);
  const currentFacts = factsOf(current[0]?.series ?? "");
  // "This and following": a later series on the calendar that carries this meeting.
  // A series that Tempoloom ended (tl_ended) is never the organizer's split.
  const later = all<{ recurring_id: string; series: string }>(
    db,
    `SELECT recurring_id, series FROM events
     WHERE calendar_id = ? AND recurring_id IS NOT NULL AND recurring_id <> ? AND series <> ''
       AND end_ms > ? AND json_extract(private_props, '$.tl_meeting') = ?
       AND json_extract(private_props, '$.tl_ended') IS NOT '1'
     GROUP BY recurring_id`,
    calendarId,
    m.series_event_id,
    now,
    m.id,
  )
    .filter(
      (e) => (factsOf(e.series)?.start ?? 0) > (currentFacts?.start ?? Number.POSITIVE_INFINITY),
    )
    .sort((a, b) => (factsOf(b.series)?.start ?? 0) - (factsOf(a.series)?.start ?? 0))[0];
  const seriesId = later?.recurring_id ?? (m.series_event_id as string);
  const instances = later ? instancesOf(seriesId) : current;
  const facts = later ? factsOf(later.series) : currentFacts;
  if (!facts) return;
  const seen = factsOf(m.series_rule) as Baseline | null;
  if (!later && seen && ruleKey(seen) === ruleKey(facts)) return;
  // The new baseline keeps what Tempoloom wrote from the form (zone, form fields).
  const keep = (b: Baseline | null) => {
    const {
      start: _s,
      end: _e,
      rrule: _r,
      summary: _m,
      attendees: _a,
      optional: _o,
      own: _w,
      ...rest
    } = b ?? ({} as Baseline);
    return rest;
  };
  const baseline = JSON.stringify({ ...keep(seen), ...facts, own: false });
  // The first look at an adopted series: nothing to compare with. Tempoloom's
  // own series has the baseline of its write (push.ts writeSeries); without one
  // the edit cannot be read, so it is logged, not dropped in silence.
  if (!seen) {
    if (m.series_owned)
      console.error(`Meeting ${m.id}: its series has no baseline; a series edit is not read`);
    run(db, "UPDATE meetings SET series_rule = ? WHERE id = ?", baseline, m.id);
    return;
  }

  // The meeting rules follow the series master.
  const was = JSON.parse(m.frequency) as MeetingFrequency;
  const start = utcToLocal(seen.zone ?? homeZone(db, userId), facts.start);
  const minutes = Math.round((facts.end - facts.start) / MINUTE);
  const changed = { ...m, series_event_id: seriesId };
  if (minutes >= 5 && minutes <= 480 && facts.end - facts.start !== seen.end - seen.start) {
    changed.duration_minutes = minutes;
    changed.shortest_minutes = Math.min(m.shortest_minutes, minutes);
  }
  if (utcToLocal(seen.zone ?? homeZone(db, userId), seen.start).minuteOfDay !== start.minuteOfDay)
    changed.ideal_minute = start.minuteOfDay;
  const next = frequencyOf(facts.rrule, start.date);
  if (next && (facts.rrule !== seen.rrule || later)) {
    changed.frequency = JSON.stringify(next);
    // Other periods: they count from the new series' first day.
    if (cadence(next) !== cadence(was) && !later) changed.starting = start.date;
  }
  if (facts.summary !== seen.summary && facts.summary.trim())
    changed.title = stripMarker(settings.markers, facts.summary);
  const guestsChanged =
    JSON.stringify([[...facts.attendees].sort(), [...facts.optional].sort()]) !==
    JSON.stringify([[...seen.attendees].sort(), [...seen.optional].sort()]);
  // Rule 22 (Proposed): a new guest is required; a guest gone from the series leaves the meeting.
  const required = facts.attendees.filter((e) => !self.has(e));
  const optional = facts.optional.filter((e) => !self.has(e));
  if (guestsChanged) {
    const before = new Map(
      all<{ email: string; hours_override: string | null }>(
        db,
        "SELECT email, hours_override FROM meeting_attendees WHERE meeting_id = ?",
        m.id,
      ).map((a) => [a.email, a.hours_override]),
    );
    run(db, "DELETE FROM meeting_attendees WHERE meeting_id = ?", m.id);
    for (const [email, req] of [
      ...required.map((e) => [e, 1] as const),
      ...optional.map((e) => [e, 0] as const),
    ])
      run(
        db,
        "INSERT OR IGNORE INTO meeting_attendees (meeting_id, email, required, hours_override) VALUES (?, ?, ?, ?)",
        m.id,
        email,
        req,
        req ? (before.get(email) ?? null) : null,
      );
  }
  // "All events" places every future occurrence again with the new rules;
  // after "this and following", the occurrences before the split stay as they are.
  const placement = (x: MeetingRow) =>
    JSON.stringify([
      x.duration_minutes,
      x.shortest_minutes,
      x.ideal_minute,
      x.frequency,
      x.starting,
    ]);
  if (!later && (placement(changed) !== placement(m) || guestsChanged))
    changed.rules_changed_at = now;
  run(
    db,
    `UPDATE meetings SET series_event_id = ?, title = ?, frequency = ?, ideal_minute = ?,
       duration_minutes = ?, shortest_minutes = ?, starting = ?, rules_changed_at = ?,
       series_rule = ? WHERE id = ?`,
    seriesId,
    changed.title,
    changed.frequency,
    changed.ideal_minute,
    changed.duration_minutes,
    changed.shortest_minutes,
    changed.starting,
    changed.rules_changed_at,
    // The master's form fields: the ones this series edit changed take the
    // calendar's value; the others stay as written, so a form edit that is not
    // written yet still differs and the next plan run writes it (the newer
    // value of each field wins).
    JSON.stringify({
      ...JSON.parse(baseline),
      ...(seen.form ? { form: masterForm(seen.form, m, changed) } : {}),
      ...(seen.title !== undefined ? { title: changed.title } : {}),
    }),
    m.id,
  );

  // The occurrences: each instance the series edit changed is kept as the calendar has it.
  const ends = /\b(UNTIL|COUNT)=/.test(facts.rrule);
  const rows = all<ManagedRow>(
    db,
    `SELECT * FROM managed_events WHERE user_id = ? AND kind = 'meeting' AND source_id = ?
       AND event_id IS NOT NULL AND end_ms > ?`,
    userId,
    m.id,
    now,
  );
  const cachedOf = (row: ManagedRow) =>
    one<Instance>(
      db,
      "SELECT event_id, start_ms, end_ms, summary, etag, series FROM events WHERE calendar_id = ? AND event_id = ?",
      row.calendar_id,
      row.event_id,
    );
  const used = new Set(rows.map((r) => r.event_id));
  const keyOf = (i: Instance) => {
    const p = periodOf(
      changed,
      instanceDate(db, userId, i.event_id, i.start_ms),
      settings.weekStart,
      zone,
    );
    return p ? `meeting:${m.id}:${p}` : null;
  };
  const free = new Map(
    instances
      .filter((i) => !used.has(i.event_id))
      .flatMap((i) => {
        const k = keyOf(i);
        return k ? [[k, i] as const] : [];
      }),
  );
  const guestsJson = (row: ManagedRow) => {
    const x = (row.extra ? JSON.parse(row.extra) : {}) as Record<string, unknown>;
    return JSON.stringify({ ...x, attendees: required, optional });
  };
  for (const row of rows) {
    let cached = cachedOf(row);
    if (!cached) {
      // The instance left with the edit: the instance of the same period in the series, if any.
      const moved = free.get(row.key);
      if (!moved) {
        // A series the organizer ended (UNTIL, COUNT): a later occurrence is
        // deleted, as a delete in the calendar (MEET-02 rule 20). Another rule
        // just has no instance in this period: the plan places it again.
        if (!ends && row.calendar_id === calendarId)
          run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
        continue;
      }
      free.delete(row.key);
      run(
        db,
        "UPDATE managed_events SET event_id = ?, etag = ? WHERE id = ?",
        moved.event_id,
        moved.etag,
        row.id,
      );
      cached = moved;
    }
    const own = factsOf(cached.series)?.own ?? true;
    const inSeries =
      factsOf(cached.series) !== null && instances.some((i) => i.event_id === cached.event_id);
    if (!inSeries) {
      // An occurrence before the split keeps its length (rule 18, "following").
      const length = Math.round((row.end_ms - row.start_ms) / MINUTE);
      if (later && length !== changed.duration_minutes)
        run(db, "UPDATE managed_events SET kept_minutes = ? WHERE id = ?", length, row.id);
      continue;
    }
    run(db, "UPDATE managed_events SET kept_minutes = NULL WHERE id = ?", row.id);
    if (own) continue;
    const retimed = cached.start_ms !== row.start_ms || cached.end_ms !== row.end_ms;
    run(
      db,
      "UPDATE managed_events SET start_ms = ?, end_ms = ?, title = ?, etag = ?, extra = ? WHERE id = ?",
      cached.start_ms,
      cached.end_ms,
      cached.summary,
      cached.etag,
      guestsChanged ? guestsJson(row) : row.extra,
      row.id,
    );
    if (retimed)
      logChange(
        db,
        userId,
        {
          meetingId: m.id,
          key: row.key,
          oldStart: row.start_ms,
          oldEnd: row.end_ms,
          newStart: cached.start_ms,
          newEnd: cached.end_ms,
          actor: "organizer",
          reason: "ruleChanged",
          written: false,
        },
        now,
      );
  }
}
