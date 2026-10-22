// Tempoloom's own recurring series for a meeting made from the form
// (docs/specs/meetings-flexible.md rule 2): one master with an RRULE on the
// meeting's calendar; each occurrence is an instance of it, and the push
// moves an instance by writing its override (RECURRENCE-ID).
import type { MeetingFrequency } from "../../scheduler/model.ts";
import { monthlyDate } from "../../scheduler/plan.ts";
import { addDays, type LocalDate, localToUtc, MINUTE, weekdayOf } from "../../shared/time.ts";
import { logManaged } from "../change-log.ts";
import { all, type Db, one, run } from "../db.ts";
import { seriesInstanceDate } from "../meeting-series.ts";
import {
  type CalendarProvider,
  type EventWrite,
  type ExternalChange,
  ProviderError,
  type SeriesFacts,
} from "../providers/types.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import { homeZone, planningZone } from "../travel.ts";
import { logChange, periodOf } from "./meeting-log.ts";
import type { MeetingRow } from "./meetings.ts";
import {
  type DesiredEvent,
  desiredRef,
  MANAGED_PROP,
  type ManagedRow,
  meetingChange,
  type PushContext,
  saveRow,
  tipOnly,
  write,
} from "./push.ts";

export const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * The rule date of a period: the day its instance starts on. Weekly: the
 * first ideal day of the week; daily: the period's day; monthly: the ideal
 * day of the month (none when the month lacks it, as the planner says).
 */
export function ruleDate(
  f: MeetingFrequency,
  period: LocalDate,
  weekStart: 1 | 7,
): LocalDate | null {
  if (f.period === "daily") return period;
  if (f.period === "monthly")
    return monthlyDate(
      period,
      "nth" in f
        ? { period: "monthly", nth: f.nth, weekday: f.weekday }
        : { period: "monthly", dayOfMonth: f.dayOfMonth },
    );
  const offset = (d: number) => (d - weekStart + 7) % 7;
  const first = [...f.idealDays].sort((a, b) => offset(a) - offset(b))[0] ?? 1;
  return addDays(period, offset(first));
}

/** The RRULE of a frequency whose first instance is on `date` (one instance per period). */
export function seriesRrule(f: MeetingFrequency, date: LocalDate): string {
  const every = (n: number | undefined) => ((n ?? 1) > 1 ? `;INTERVAL=${n}` : "");
  if (f.period === "daily") return `FREQ=DAILY${every(f.everyDays)}`;
  if (f.period === "weekly")
    return `FREQ=WEEKLY${every(f.everyWeeks)};BYDAY=${BYDAY[weekdayOf(date) - 1]}`;
  if ("nth" in f)
    return `FREQ=MONTHLY${every(f.everyMonths)};BYDAY=${f.nth === "last" ? -1 : f.nth}${BYDAY[f.weekday - 1]}`;
  // Day 31 is the month's last day (plan.ts monthlyDate). Day 29 or 30 has no
  // instance in February; the push adds one there when the plan places it.
  const days = f.dayOfMonth === 31 ? "-1" : `${f.dayOfMonth}`;
  return `FREQ=MONTHLY${every(f.everyMonths)};BYMONTHDAY=${days}`;
}

export interface SeriesPlan {
  rrule: string;
  timeZone: string;
  start: number;
  end: number;
  /** The rule start of each given period, by period start. */
  ruleStarts: Map<LocalDate, number>;
}

/**
 * The master of a new series that begins in `first` (a period start), and the
 * rule start of each period in `periods`. The rule is the ideal time in the
 * home zone: its DTSTART, its BYDAY and its EXDATEs are in that one zone. A
 * trip moves single occurrences (overrides), not the rule.
 */
export function planSeries(
  db: Db,
  m: MeetingRow,
  first: LocalDate,
  periods: LocalDate[],
): SeriesPlan | null {
  const f = JSON.parse(m.frequency) as MeetingFrequency;
  const { weekStart } = getSettings(db, m.user_id);
  const zone = homeZone(db, m.user_id);
  const at = (p: LocalDate) => {
    const d = ruleDate(f, p, weekStart);
    return d === null ? null : localToUtc(zone, d, m.ideal_minute);
  };
  const date = ruleDate(f, first, weekStart);
  const start = at(first);
  if (date === null || start === null) return null;
  const ruleStarts = new Map<LocalDate, number>();
  for (const p of periods) {
    const t = at(p);
    if (t !== null) ruleStarts.set(p, t);
  }
  return {
    rrule: seriesRrule(f, date),
    timeZone: zone,
    start,
    end: start + m.duration_minutes * MINUTE,
    ruleStarts,
  };
}

/**
 * The master facts that a series edit is compared with (series-edits.ts):
 * what Tempoloom wrote, and the zone of the rule. Never read back, so a
 * missing read after the write cannot leave a series without a baseline.
 */
export type Baseline = SeriesFacts & {
  /** The home zone the rule is written in. */
  zone?: string;
  /** The form fields that make the rule (`formKey`) when the master was written. */
  form?: string;
  /** What Tempoloom wrote on the master from the form. */
  title?: string;
  description?: string;
  location?: string;
  visibility?: string;
};
export function baselineOf(w: EventWrite, organizer: string): Baseline {
  return {
    start: w.start,
    end: w.end,
    rrule: w.recurrence ?? "",
    summary: w.summary,
    attendees: (w.attendees ?? []).map((e) => e.toLowerCase()).filter((e) => e !== organizer),
    optional: (w.optionalAttendees ?? []).map((e) => e.toLowerCase()),
    own: false,
    ...(w.timeZone ? { zone: w.timeZone } : {}),
    description: w.description,
    location: w.location ?? "",
    visibility: w.visibility ?? "default",
  };
}

/** The form fields that make a series rule: a change of one of them needs a new series. */
export const formKey = (m: MeetingRow) =>
  JSON.stringify([m.frequency, m.starting, m.duration_minutes, m.ideal_minute]);

/**
 * The organizer deleted the whole series in a calendar app (SPEC-MEET-02
 * edge case 5): the meeting turns off and keeps its rules, and the change log
 * says why. Called only on a "not found" from the calendar for the series.
 */
export function seriesDeleted(db: Db, userId: string, meetingId: string, now: number): void {
  run(db, "UPDATE meetings SET enabled = 0, rules_changed_at = ? WHERE id = ?", now, meetingId);
  forgetSeries(db, meetingId);
  logChange(
    db,
    userId,
    {
      meetingId,
      key: `meeting:${meetingId}`,
      oldStart: null,
      oldEnd: null,
      newStart: null,
      newEnd: null,
      actor: "organizer",
      reason: "seriesDeleted",
      written: false,
    },
    now,
  );
}

/** The period key of a series instance (`meeting:<id>:<period>`), as adoptInstances counts it. */
export const instanceDate = (db: Db, userId: string, id: string, start: number) =>
  seriesInstanceDate(planningZone(db, userId), id, start);

/** The calendar of a meeting's series, as the account and the provider name it. */
export function seriesTarget(db: Db, m: MeetingRow) {
  return one<{ account_id: string; provider_id: string }>(
    db,
    "SELECT account_id, provider_id FROM calendars WHERE id = ?",
    m.series_calendar_id,
  );
}

/** Locked occurrences that start after `now`: they stay when the series ends (LCK-2). */
export const lockedIds = (db: Db, m: MeetingRow, now: number) =>
  all<{ event_id: string }>(
    db,
    `SELECT event_id FROM managed_events WHERE kind = 'meeting' AND source_id = ? AND locked = 1
       AND start_ms > ? AND event_id IS NOT NULL`,
    m.id,
    now,
  ).map((r) => r.event_id);

/**
 * Ends Tempoloom's own series at `now` (MEET-02 rules 27-29): an instance
 * that starts before `now` stays, a later one goes, except the ids in `keep`.
 * The provider and this cleanup both use the instance's start (an override's
 * own start, else its rule time). The meeting forgets the series, so the next
 * plan run writes a new one when it places.
 */
export async function endOwnSeries(
  db: Db,
  provider: (accountId: string) => CalendarProvider,
  m: MeetingRow,
  now: number,
  keep: string[],
): Promise<void> {
  if (!m.series_owned || !m.series_event_id) return;
  const cal = seriesTarget(db, m);
  const p = cal ? provider(cal.account_id) : undefined;
  if (cal && p?.endSeries) await p.endSeries(cal.provider_id, m.series_event_id, now, keep);
  const instances =
    "SELECT event_id FROM events WHERE calendar_id = ? AND recurring_id = ? AND start_ms > ?";
  const kept = keep.length > 0 ? `AND event_id NOT IN (${keep.map(() => "?").join(", ")})` : "";
  run(
    db,
    `DELETE FROM managed_events WHERE kind = 'meeting' AND source_id = ? AND start_ms > ?
       AND event_id IN (${instances}) ${kept}`,
    m.id,
    now,
    m.series_calendar_id,
    m.series_event_id,
    now,
    ...keep,
  );
  run(
    db,
    `DELETE FROM events WHERE calendar_id = ? AND recurring_id = ? AND start_ms > ? ${kept}`,
    m.series_calendar_id,
    m.series_event_id,
    now,
    ...keep,
  );
  forgetSeries(db, m.id);
}

/** The meeting has no series now; the next plan run that places it writes one. */
export const forgetSeries = (db: Db, meetingId: string) =>
  run(
    db,
    "UPDATE meetings SET series_calendar_id = NULL, series_event_id = NULL, series_rule = '' WHERE id = ?",
    meetingId,
  );

// ---------------------------------------------------------------- push steps

/**
 * Writes the series of a meeting made from the form (meetings-flexible.md
 * rule 2) and makes its instances the managed rows of the planned periods;
 * the push then moves each instance that the plan placed elsewhere (an
 * override). A period that already has an event of its own (a single event
 * from before series, a locked occurrence of an ended series) gets an EXDATE,
 * so it is never there twice. Returns the number of instances made.
 */
export async function writeSeries(
  ctx: PushContext,
  m: MeetingRow,
  own: DesiredEvent[],
  byKey: Map<string, ManagedRow>,
): Promise<number> {
  const { db, userId, now } = ctx;
  const sorted = [...own].sort((a, b) => (a.key < b.key ? -1 : 1));
  const [first] = sorted;
  if (!first) return 0;
  const { provider, providerCalendarId } = ctx.target(first.calendarId);
  if (!provider.seriesInstances) return 0;
  const period = (key: string) => key.slice(key.lastIndexOf(":") + 1);
  const mine = sorted.filter((d) => d.calendarId === first.calendarId);
  const plan = planSeries(
    db,
    m,
    period(first.key),
    mine.map((d) => period(d.key)),
  );
  if (!plan) return 0;
  const taken = mine.filter((d) => byKey.get(d.key)?.event_id);
  // The master takes the fields of the last occurrence: as the instances past
  // the planning window will be (rule 20), so most instances need no override.
  const model = mine.at(-1) ?? first;
  const master: EventWrite = {
    ...write(userId, model),
    start: plan.start,
    end: plan.end,
    recurrence: plan.rrule,
    timeZone: plan.timeZone,
    exdates: taken.flatMap((d) => plan.ruleStarts.get(period(d.key)) ?? []),
    privateProps: { [MANAGED_PROP]: "1", tl_user: userId, tl_meeting: m.id },
  };
  const ev = await provider.insertEvent(providerCalendarId, master);
  const seriesId = ev.recurringId ?? ev.id;
  // From the first rule start: an instance whose rule time passed in the current period is its row.
  const from = Math.min(plan.start, ...mine.map((d) => d.start));
  const last = Math.max(...mine.map((d) => d.end));
  const instances = await provider.seriesInstances(
    providerCalendarId,
    seriesId,
    from,
    last + 86_400_000,
  );
  const { weekStart } = getSettings(db, userId);
  const zone = planningZone(db, userId);
  const wantedByKey = new Map(mine.map((d) => [d.key, d]));
  let made = 0;
  for (const inst of instances) {
    cacheEvent(db, first.calendarId, inst);
    const p = periodOf(m, instanceDate(db, userId, inst.id, inst.start), weekStart, zone);
    const d = p ? wantedByKey.get(`meeting:${m.id}:${p}`) : undefined;
    if (!d || byKey.get(d.key)?.event_id) continue;
    // The row holds what the master wrote; the push writes what differs.
    saveRow(
      db,
      userId,
      { ...model, key: d.key, start: inst.start, end: inst.end },
      inst.id,
      inst.etag,
      byKey.get(d.key)?.id,
    );
    const row = one<ManagedRow>(
      db,
      "SELECT * FROM managed_events WHERE user_id = ? AND key = ?",
      userId,
      d.key,
    );
    if (row) byKey.set(d.key, row);
    ctx.written?.set(d.key, { start: inst.start, end: inst.end });
    logManaged(db, userId, desiredRef(d, inst.id), "create", { ...d, ...inst }, now);
    made++;
  }
  run(
    db,
    "UPDATE meetings SET series_calendar_id = ?, series_event_id = ?, series_rule = ? WHERE id = ?",
    first.calendarId,
    seriesId,
    JSON.stringify({
      ...baselineOf(master, (first.organizer ?? "").toLowerCase()),
      form: formKey(m),
      title: m.title,
    }),
    m.id,
  );
  return made;
}

/**
 * The instance of `d`'s period in the series, when no row holds it (its
 * rule time is after the planning window): it becomes the row and moves to the
 * planned time. False when the period has no instance.
 */
export async function moveRuleInstance(
  ctx: PushContext,
  provider: CalendarProvider,
  providerCalendarId: string,
  series: string,
  d: DesiredEvent,
  row: ManagedRow | undefined,
): Promise<boolean> {
  if (!provider.seriesInstances) return false;
  const { db, userId, now } = ctx;
  const m = one<MeetingRow>(db, "SELECT * FROM meetings WHERE id = ?", d.sourceId);
  if (!m) return false;
  const period = d.key.slice(d.key.lastIndexOf(":") + 1);
  const zone = planningZone(db, userId);
  const { weekStart } = getSettings(db, userId);
  const from = localToUtc(zone, period, 0) - 86_400_000;
  const used = new Set(
    all<{ event_id: string }>(
      db,
      "SELECT event_id FROM managed_events WHERE user_id = ? AND event_id IS NOT NULL",
      userId,
    ).map((r) => r.event_id),
  );
  const inst = (
    await provider.seriesInstances(providerCalendarId, series, from, from + 34 * 86_400_000)
  ).find(
    (e) =>
      !used.has(e.id) &&
      periodOf(m, instanceDate(db, userId, e.id, e.start), weekStart, zone) === period,
  );
  if (!inst) return false;
  cacheEvent(db, d.calendarId, inst);
  const seen = {
    ...d,
    start: inst.start,
    end: inst.end,
    title: inst.summary,
    description: inst.description,
    busy: inst.busy,
  };
  saveRow(db, userId, seen, inst.id, inst.etag, row?.id);
  const fresh = one<ManagedRow>(
    db,
    "SELECT * FROM managed_events WHERE user_id = ? AND key = ?",
    userId,
    d.key,
  );
  const change = fresh
    ? meetingChange(
        fresh,
        { busy: inst.busy ? 1 : 0, own_visibility: null, description: inst.description },
        d,
      )
    : null;
  let ev = inst;
  if (change) {
    ev = await provider.editExternal(providerCalendarId, inst.id, change, inst.etag);
    cacheEvent(db, d.calendarId, ev);
  }
  saveRow(db, userId, d, ev.id, ev.etag, fresh?.id);
  ctx.written?.set(d.key, { start: d.start, end: d.end });
  logManaged(db, userId, desiredRef(d, ev.id), "create", d, now);
  return true;
}

/**
 * Keeps each series of Tempoloom's own meetings in line with its form
 * (meetings-flexible.md rule 2), before the rows are read. A series the
 * calendar answers "not found" for is gone: the meeting turns off. A new home
 * zone or a new rule (frequency, start date, length, ideal time) ends the
 * series; this run writes a new one. A new title, guest list, description,
 * location or privacy goes to the master. A form edit is saved first; this
 * run writes it, and a calendar of a disconnected account waits. Returns the
 * meetings that turned off: this run writes nothing more for them.
 */
export async function syncOwnSeries(
  ctx: PushContext,
  frozen: Set<string>,
  desired: DesiredEvent[],
): Promise<Set<string>> {
  const { db, userId, now } = ctx;
  const home = homeZone(db, userId);
  const off = new Set<string>();
  for (const m of all<MeetingRow>(
    db,
    `SELECT * FROM meetings WHERE user_id = ? AND enabled = 1 AND series_owned = 1
       AND series_event_id IS NOT NULL`,
    userId,
  )) {
    const series = m.series_event_id as string;
    const calendarId = m.series_calendar_id;
    if (!calendarId || frozen.has(calendarId)) continue;
    const base = (m.series_rule ? JSON.parse(m.series_rule) : null) as Baseline | null;
    try {
      const { provider, providerCalendarId } = ctx.target(calendarId);
      // No instance in the cached window does not mean gone: ask the calendar.
      if (
        provider.seriesInstances &&
        !one(
          db,
          "SELECT 1 FROM events WHERE calendar_id = ? AND recurring_id = ?",
          calendarId,
          series,
        )
      )
        await provider.seriesInstances(providerCalendarId, series, now, now + 86_400_000);
      if (!base) continue;
      if ((base.zone && base.zone !== home) || (base.form && base.form !== formKey(m))) {
        await endOwnSeries(db, () => provider, m, now, lockedIds(db, m, now));
        continue;
      }
      const d = desired.filter((x) => x.kind === "meeting" && x.sourceId === m.id).at(-1);
      if (!base.form || !d) continue;
      const change: ExternalChange = {};
      const title = m.title;
      const summary =
        base.title && base.summary.includes(base.title)
          ? base.summary.replace(base.title, title)
          : d.title;
      if (base.title !== undefined && base.title !== title) change.summary = summary;
      if (
        base.description !== undefined &&
        base.description !== d.description &&
        !tipOnly(base.description, d.description)
      )
        change.description = d.description;
      if ((base.location ?? "") !== (d.location ?? "")) change.location = d.location ?? "";
      if ((base.visibility ?? "default") !== (d.visibility ?? "default"))
        change.visibility = d.visibility ?? "default";
      const guests = (req: string[], opt: string[]) =>
        new Map([
          ...req.map((e) => [e.toLowerCase(), false] as const),
          ...opt.map((e) => [e.toLowerCase(), true] as const),
        ]);
      const before = guests(base.attendees, base.optional);
      const after = guests(d.attendees ?? [], d.optionalAttendees ?? []);
      const add = [...after]
        .filter(([e, optional]) => before.get(e) !== optional)
        .map(([email, optional]) => ({ email, optional }));
      const remove = [...before.keys()].filter((e) => !after.has(e));
      if (add.length > 0 || remove.length > 0) change.guests = { add, remove };
      if (Object.keys(change).length === 0) continue;
      await provider.editExternal(providerCalendarId, series, change, null);
      run(
        db,
        "UPDATE meetings SET series_rule = ? WHERE id = ?",
        JSON.stringify({
          ...base,
          summary: change.summary ?? base.summary,
          title,
          description: change.description ?? base.description,
          location: d.location ?? "",
          visibility: d.visibility ?? "default",
          attendees: (d.attendees ?? []).map((e) => e.toLowerCase()),
          optional: (d.optionalAttendees ?? []).map((e) => e.toLowerCase()),
        }),
        m.id,
      );
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === "not_found" && err.what === "event") {
        seriesDeleted(db, userId, m.id, now);
        off.add(m.id);
      } else if (err.kind === "not_found")
        console.error(`Meeting ${m.id}: calendar missing; its series is not written`, err);
      else console.error(`Writing the series of meeting ${m.id} failed`, err);
    }
  }
  return off;
}
