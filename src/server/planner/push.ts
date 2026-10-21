// Writes the desired managed events to calendars: creates, moves and deletes
// events so that the calendars match the plan. Unchanged events get no write.
import { randomUUID } from "node:crypto";
import { localToUtc } from "../../shared/time.ts";
import { logManaged, pruneChangeLog } from "../change-log.ts";
import { all, type Db, one, run } from "../db.ts";
import {
  type CalendarProvider,
  type EventWrite,
  type ExternalChange,
  ProviderError,
  type ProviderEvent,
} from "../providers/types.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import { homeZone, planningZone } from "../travel.ts";
import { periodOf } from "./meeting-log.ts";
import type { MeetingRow } from "./meetings.ts";
import { ACTIVE } from "./mirror.ts";
import {
  type Baseline,
  baselineOf,
  endOwnSeries,
  forgetSeries,
  instanceDate,
  lockedIds,
  planSeries,
} from "./series.ts";

export interface DesiredEvent {
  key: string;
  kind: string;
  sourceId: string;
  calendarId: string;
  start: number;
  end: number;
  title: string;
  description: string;
  busy: boolean;
  colorId: string | null;
  location?: string;
  attendees?: string[];
  optionalAttendees?: string[];
  organizer?: string;
  /** The guests get no notices from the calendar server (habit guests). */
  quietGuests?: boolean;
  reminders?: EventWrite["reminders"];
  visibility?: EventWrite["visibility"];
  allDayDates?: EventWrite["allDayDates"];
}

export interface ManagedRow {
  id: string;
  user_id: string;
  calendar_id: string;
  event_id: string | null;
  key: string;
  kind: string;
  source_id: string;
  start_ms: number;
  end_ms: number;
  busy: number;
  title: string;
  description: string;
  color_id: string | null;
  locked: number;
  user_edited: number;
  etag: string | null;
  extra: string;
  /** Buffers: the length the user gave this event in the calendar (buffers rule 14). */
  kept_minutes: number | null;
  /** 1 when the user started the event or logged it as work (PRG-3, PRG-20). */
  started: number;
}

/** Guests, location, reminders and visibility as stored in `managed_events.extra`. */
const extraOf = (d: DesiredEvent) =>
  d.attendees || d.optionalAttendees || d.location || d.reminders || d.visibility || d.allDayDates
    ? JSON.stringify({
        location: d.location ?? "",
        attendees: d.attendees ?? [],
        optional: d.optionalAttendees ?? [],
        ...(d.organizer ? { organizer: d.organizer } : {}),
        ...(d.quietGuests ? { quietGuests: true } : {}),
        ...(d.reminders ? { reminders: d.reminders } : {}),
        ...(d.visibility ? { visibility: d.visibility } : {}),
        ...(d.allDayDates ? { allDayDates: d.allDayDates } : {}),
      })
    : "";

interface Extra {
  location?: string;
  attendees?: string[];
  optional?: string[];
  organizer?: string;
  quietGuests?: boolean;
  reminders?: DesiredEvent["reminders"];
  visibility?: DesiredEvent["visibility"];
  allDayDates?: DesiredEvent["allDayDates"];
}

const extraFrom = (row: ManagedRow): Extra => (row.extra ? JSON.parse(row.extra) : {}) as Extra;

/**
 * The write of a managed event as it is stored, with a new time, title or
 * status: for changes outside a plan run, such as a drag in the planner.
 */
export function rowWrite(
  userId: string,
  row: ManagedRow,
  change: { start: number; end: number; title: string; busy: boolean },
): EventWrite {
  const x = extraFrom(row);
  return write(userId, {
    key: row.key,
    kind: row.kind,
    sourceId: row.source_id,
    calendarId: row.calendar_id,
    ...change,
    description: row.description,
    colorId: row.color_id,
    ...(x.location ? { location: x.location } : {}),
    ...(x.attendees?.length ? { attendees: x.attendees } : {}),
    ...(x.optional?.length ? { optionalAttendees: x.optional } : {}),
    ...(x.organizer ? { organizer: x.organizer } : {}),
    ...(x.quietGuests ? { quietGuests: true } : {}),
    ...(x.reminders ? { reminders: x.reminders } : {}),
    ...(x.visibility ? { visibility: x.visibility } : {}),
    ...(x.allDayDates ? { allDayDates: x.allDayDates } : {}),
  });
}

export interface PushContext {
  db: Db;
  userId: string;
  /** Provider and provider calendar id for one of our calendar ids. */
  target: (calendarId: string) => { provider: CalendarProvider; providerCalendarId: string };
  now: number;
  /** Also compare the time and color of mirroring copies with the calendar (full reconcile). */
  fullCheck?: boolean;
  /** Keys to repair (support-troubleshooting.md rule 10): compared in full, logged as restored. */
  repair?: ReadonlySet<string>;
  /** Filled with the repair keys that were compared in full and are now as the plan gives them. */
  repaired?: Set<string>;
  /** Keys of events that stay as they are: the events of waiting items (accounts rule 16). */
  keep?: ReadonlySet<string>;
  /** Filled with what the push wrote per key: the new times, or null for a delete (SCH-119 log). */
  written?: Map<string, { start: number; end: number } | null>;
  /**
   * Ended events that go back to the plan (manual start mode, PRG-3): a new
   * event of the same item moves one of them instead of being created.
   */
  reopen?: ManagedRow[];
}

export interface PushResult {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
}

/** Private properties that mark an event as managed by Tempoloom. */
export const MANAGED_PROP = "tl";
export const KEY_PROP = "tl_key";

function write(userId: string, d: DesiredEvent): EventWrite {
  return {
    summary: d.title,
    description: d.description,
    start: d.start,
    end: d.end,
    busy: d.busy,
    colorId: d.colorId,
    privateProps: { [MANAGED_PROP]: "1", [KEY_PROP]: d.key, tl_user: userId },
    ...(d.location ? { location: d.location } : {}),
    ...(d.attendees ? { attendees: d.attendees } : {}),
    ...(d.optionalAttendees ? { optionalAttendees: d.optionalAttendees } : {}),
    ...(d.organizer ? { organizer: d.organizer } : {}),
    ...(d.quietGuests ? { quietGuests: true } : {}),
    ...(d.reminders ? { reminders: d.reminders } : {}),
    ...(d.visibility ? { visibility: d.visibility } : {}),
    ...(d.allDayDates ? { allDayDates: d.allDayDates } : {}),
  };
}

interface Cached {
  summary: string;
  description: string;
  busy: number;
  etag: string | null;
  start_ms: number;
  end_ms: number;
  color_id: string | null;
  alerts: number;
  /** Null until the event is read again after migration 34: no drift. */
  own_visibility: string | null;
}

function differs(
  row: ManagedRow,
  cached: Cached | undefined,
  d: DesiredEvent,
  fullCheck: boolean,
): boolean {
  if (
    row.start_ms !== d.start ||
    row.end_ms !== d.end ||
    row.title !== d.title ||
    row.description !== d.description ||
    Boolean(row.busy) !== d.busy ||
    (row.color_id ?? null) !== (d.colorId ?? null) ||
    row.calendar_id !== d.calendarId ||
    row.extra !== extraOf(d)
  ) {
    return true;
  }
  if (row.kind === "mirror" && cached) {
    // A copy never alerts (mirroring rule 30).
    if (cached.alerts) return true;
    // The full reconcile also puts back a copy's time and color (rules 38, 39).
    if (
      fullCheck &&
      (cached.start_ms !== d.start ||
        cached.end_ms !== d.end ||
        (cached.color_id ?? null) !== (d.colorId ?? null))
    )
      return true;
  }
  // The calendar copy drifted (a user edit that does not lock): write it back.
  return (
    cached !== undefined &&
    (cached.summary !== d.title ||
      cached.description !== d.description ||
      Boolean(cached.busy) !== d.busy)
  );
}

/** The paragraph that holds an event tip (planning-event-content.md CNT-15). */
export const TIP_PREFIX = "Tempoloom tip: ";
const withoutTip = (description: string) =>
  description
    .split("\n\n")
    .filter((p) => !p.startsWith(TIP_PREFIX))
    .join("\n\n");
/** Two descriptions that differ only in their tip. */
export const tipOnly = (a: string, b: string) => a !== b && withoutTip(a) === withoutTip(b);

/**
 * The change of a meeting occurrence after its creation
 * (meetings-flexible-rescheduling.md rule 22): only the fields whose
 * Tempoloom value changed since the last write (`row`), and free/busy and
 * privacy where the calendar copy drifted from them. The organizer's own
 * edits of title, description, location, color, note and guests stay. Null
 * when nothing is to be written.
 */
export function meetingChange(
  row: ManagedRow,
  cached: Pick<Cached, "busy" | "own_visibility" | "description"> | undefined,
  d: DesiredEvent,
  quiet = false,
): ExternalChange | null {
  const was = extraFrom(row);
  const change: ExternalChange = {};
  if (row.start_ms !== d.start || row.end_ms !== d.end) {
    change.start = d.start;
    change.end = d.end;
  }
  if (row.title !== d.title) change.summary = d.title;
  // CNT-15: a tip change alone (tips on or off) never writes over the
  // organizer's own description, and goes only where it mails no guest.
  if (
    row.description !== d.description &&
    (!tipOnly(row.description, d.description) || (quiet && cached?.description === row.description))
  )
    change.description = d.description;
  if (Boolean(row.busy) !== d.busy || (cached && Boolean(cached.busy) !== d.busy))
    change.busy = d.busy;
  const visibility = d.visibility ?? "default";
  if (
    (was.visibility ?? "default") !== visibility ||
    (cached?.own_visibility != null && cached.own_visibility !== visibility)
  )
    change.visibility = visibility;
  if ((row.color_id ?? null) !== (d.colorId ?? null)) change.colorId = d.colorId ?? null;
  if ((was.location ?? "") !== (d.location ?? "")) change.location = d.location ?? "";
  if (JSON.stringify(was.reminders ?? null) !== JSON.stringify(d.reminders ?? null))
    change.reminders = d.reminders ?? { minutes: [] };
  const guestMap = (required: string[] = [], optional: string[] = []) =>
    new Map([
      ...required.map((e) => [e.toLowerCase(), false] as const),
      ...optional.map((e) => [e.toLowerCase(), true] as const),
    ]);
  const before = guestMap(was.attendees, was.optional);
  const after = guestMap(d.attendees, d.optionalAttendees);
  const add = [...after]
    .filter(([email, optional]) => before.get(email) !== optional)
    .map(([email, optional]) => ({ email, optional }));
  const remove = [...before.keys()].filter((email) => !after.has(email));
  if (add.length > 0 || remove.length > 0) change.guests = { add, remove };
  return Object.keys(change).length > 0 ? change : null;
}

/**
 * Makes the user's future managed events equal to `desired`. Events that
 * have started are never changed, except a move to a later start (a snooze). Locked events are never moved or deleted.
 * Writes run in the order deletes, updates, creates.
 */
export async function pushSchedule(
  ctx: PushContext,
  allDesired: DesiredEvent[],
): Promise<PushResult> {
  const { db, userId, now } = ctx;
  const result: PushResult = { created: 0, updated: 0, deleted: 0, conflicts: 0 };
  const repaired = (key: string) => ctx.repair?.has(key) ?? false;
  // Calendars of a disconnected account are neither read nor written
  // (accounts-login-emails-permissions.md rule 16): their events stay as they are.
  const frozen = new Set(
    all<{ id: string }>(
      db,
      `SELECT c.id FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND a.status <> 'ok'`,
      userId,
    ).map((c) => c.id),
  );
  // Copies of a paused mirroring policy stay as they are too.
  const paused = new Set(
    all<{ id: string }>(
      db,
      `SELECT p.id FROM mirror_policies p WHERE p.user_id = ? AND NOT ${ACTIVE}`,
      userId,
    ).map((p) => p.id),
  );
  await restartMovedZones(ctx, frozen);
  const rows = all<ManagedRow>(
    db,
    "SELECT * FROM managed_events WHERE user_id = ? AND end_ms > ?",
    userId,
    now,
  ).filter(
    (r) =>
      !frozen.has(r.calendar_id) &&
      !ctx.keep?.has(r.key) &&
      !(r.kind === "mirror" && paused.has(r.source_id)),
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Whether an edit of an event with guests mails them, per calendar (CNT-15).
  const mails = new Map<string, Promise<boolean>>();
  const quiet = async (calendarId: string) => {
    const { provider, providerCalendarId } = ctx.target(calendarId);
    if (!mails.has(calendarId))
      mails.set(
        calendarId,
        Promise.resolve(provider.notifiesGuests?.(providerCalendarId) ?? true).catch(() => true),
      );
    return (await mails.get(calendarId)) === false;
  };
  const wanted = new Set(allDesired.map((d) => d.key));
  const desired = allDesired.filter((d) => !frozen.has(d.calendarId));
  for (const m of all<MeetingRow>(
    db,
    "SELECT * FROM meetings WHERE user_id = ? AND enabled = 1 AND series_owned = 1 AND series_event_id IS NULL",
    userId,
  )) {
    const own = desired.filter((d) => d.kind === "meeting" && d.sourceId === m.id);
    // One meeting's calendar error never stops the plan run of the user.
    try {
      result.created += await writeSeries(ctx, m, own, byKey);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      console.error(`Writing the series of meeting ${m.id} failed`, err);
      result.conflicts++;
    }
  }

  for (const row of rows) {
    if (wanted.has(row.key) || row.locked || row.start_ms <= now) continue;
    await deleteRemote(ctx, row);
    run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
    ctx.written?.set(row.key, null);
    if (row.event_id)
      logManaged(db, userId, managedRef(row, row.event_id), "delete", plain(row), now);
    result.deleted++;
  }

  const creates: DesiredEvent[] = [];
  for (const d of desired) {
    const row = byKey.get(d.key);
    if (!row?.event_id || row.calendar_id !== d.calendarId) {
      creates.push(d);
      continue;
    }
    // Never change a started event (SCH-60a), unless the plan moves it to a
    // later start: only a snooze does that (plan.ts snoozedLater). A locked
    // event may get a new title or status but never a new time.
    if (row.start_ms <= now && d.start <= now) continue;
    if (row.locked && (row.start_ms !== d.start || row.end_ms !== d.end)) continue;
    const cached = one<Cached>(
      db,
      `SELECT summary, description, busy, etag, start_ms, end_ms, color_id, alerts, own_visibility
       FROM events WHERE calendar_id = ? AND event_id = ?`,
      row.calendar_id,
      row.event_id,
    );
    // A meeting occurrence is never written whole after its creation (rule 22).
    const change =
      row.kind === "meeting"
        ? meetingChange(
            row,
            cached,
            d,
            tipOnly(row.description, d.description) && (await quiet(row.calendar_id)),
          )
        : differs(row, cached, d, (ctx.fullCheck ?? false) || repaired(row.key));
    if (!change) {
      if (repaired(row.key)) ctx.repaired?.add(row.key);
      continue;
    }
    const { provider, providerCalendarId } = ctx.target(row.calendar_id);
    const etag = cached?.etag ?? row.etag;
    try {
      const ev =
        change === true
          ? await provider.updateEvent(providerCalendarId, row.event_id, write(userId, d), etag)
          : await provider.editExternal(providerCalendarId, row.event_id, change, etag);
      cacheEvent(db, row.calendar_id, ev);
      saveRow(db, userId, d, ev.id, ev.etag, row.id);
      ctx.written?.set(d.key, { start: d.start, end: d.end });
      const moved = row.start_ms !== d.start || row.end_ms !== d.end;
      logManaged(db, userId, desiredRef(d, ev.id), "update", { ...d, moved }, now, {
        restored: repaired(row.key),
      });
      if (repaired(row.key)) ctx.repaired?.add(row.key);
      result.updated++;
    } catch (err) {
      // precondition_failed: the user changed the event since our last read. The
      // next pull reads their change; the plan adapts on the following run.
      if (err instanceof ProviderError && err.kind === "precondition_failed") {
        result.conflicts++;
        continue;
      }
      if (err instanceof ProviderError && err.kind === "not_found") {
        run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
        ctx.written?.set(row.key, null);
        result.conflicts++;
        continue;
      }
      throw err;
    }
  }

  const reopen = (ctx.reopen ?? []).filter((r) => !frozen.has(r.calendar_id));
  for (const d of creates) {
    const row = byKey.get(d.key);
    if (row && (row.locked || row.start_ms <= now)) continue;
    if (!row && (await moveReopened(ctx, reopen, d))) {
      ctx.written?.set(d.key, { start: d.start, end: d.end });
      result.updated++;
      continue;
    }
    if (row?.event_id) await deleteRemote(ctx, row);
    const { provider, providerCalendarId } = ctx.target(d.calendarId);
    // A period of Tempoloom's own series with no instance gets one in the series.
    const series =
      d.kind === "meeting"
        ? one<{ series_event_id: string }>(
            db,
            `SELECT series_event_id FROM meetings WHERE id = ? AND series_owned = 1
               AND series_event_id IS NOT NULL AND series_calendar_id = ?`,
            d.sourceId,
            d.calendarId,
          )?.series_event_id
        : undefined;
    let ev: ProviderEvent;
    try {
      // The period's rule instance may start after the planning window, so no
      // row holds it yet: move that instance, never add a second one.
      if (series && (await moveRuleInstance(ctx, provider, providerCalendarId, series, d, row))) {
        result.created++;
        continue;
      }
      ev =
        series && provider.addInstance
          ? await provider.addInstance(providerCalendarId, series, write(userId, d))
          : await provider.insertEvent(providerCalendarId, write(userId, d));
    } catch (err) {
      // The organizer deleted the whole series: the next run writes a new one.
      if (series && err instanceof ProviderError && err.kind === "not_found") {
        forgetSeries(db, d.sourceId);
        result.conflicts++;
        continue;
      }
      throw err;
    }
    cacheEvent(db, d.calendarId, ev);
    saveRow(db, userId, d, ev.id, ev.etag, row?.id);
    ctx.written?.set(d.key, { start: d.start, end: d.end });
    logManaged(db, userId, desiredRef(d, ev.id), "create", d, now);
    if (repaired(d.key)) ctx.repaired?.add(d.key);
    result.created++;
  }
  pruneChangeLog(db, now);
  return result;
}

/**
 * Writes the series of a meeting made from the form (meetings-flexible.md
 * rule 2) and makes its instances the managed rows of the planned periods;
 * the push then moves each instance that the plan placed elsewhere (an
 * override). A period that already has an event of its own (a single event
 * from before series, a locked occurrence of an ended series) gets an EXDATE,
 * so it is never there twice. Returns the number of instances made.
 */
async function writeSeries(
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
    JSON.stringify(baselineOf(master, (first.organizer ?? "").toLowerCase())),
    m.id,
  );
  return made;
}

/**
 * C1: the instance of `d`'s period in the series, when no row holds it (its
 * rule time is after the planning window): it becomes the row and moves to the
 * planned time. False when the period has no instance.
 */
async function moveRuleInstance(
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
 * W8: a series repeats in the home zone it was written in. When the home zone
 * changes, the series ends and this run writes one in the new zone.
 */
async function restartMovedZones(ctx: PushContext, frozen: Set<string>): Promise<void> {
  const { db, userId, now } = ctx;
  const home = homeZone(db, userId);
  for (const m of all<MeetingRow>(
    db,
    "SELECT * FROM meetings WHERE user_id = ? AND series_owned = 1 AND series_event_id IS NOT NULL",
    userId,
  )) {
    const zone = (m.series_rule ? (JSON.parse(m.series_rule) as Baseline) : null)?.zone;
    const calendarId = m.series_calendar_id;
    if (!zone || zone === home || !calendarId || frozen.has(calendarId)) continue;
    try {
      const { provider } = ctx.target(calendarId);
      await endOwnSeries(db, () => provider, m, now, lockedIds(db, m, now));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      console.error(`Ending the series of meeting ${m.id} failed`, err);
    }
  }
}

/** PRG-3: moves an ended, unstarted event of the same item to the new time. */
async function moveReopened(
  ctx: PushContext,
  reopen: ManagedRow[],
  d: DesiredEvent,
): Promise<boolean> {
  const i = reopen.findIndex(
    (r) =>
      r.kind === d.kind &&
      r.source_id === d.sourceId &&
      r.calendar_id === d.calendarId &&
      (d.kind !== "habit" || r.key === d.key),
  );
  const old = reopen[i];
  if (!old?.event_id) return false;
  reopen.splice(i, 1);
  const { db, userId, now } = ctx;
  const cached = one<{ etag: string | null }>(
    db,
    "SELECT etag FROM events WHERE calendar_id = ? AND event_id = ?",
    old.calendar_id,
    old.event_id,
  );
  const { provider, providerCalendarId } = ctx.target(old.calendar_id);
  try {
    const ev = await provider.updateEvent(
      providerCalendarId,
      old.event_id,
      write(userId, d),
      cached?.etag ?? old.etag,
    );
    cacheEvent(db, old.calendar_id, ev);
    run(db, "UPDATE managed_events SET key = ? WHERE id = ?", d.key, old.id);
    saveRow(db, userId, d, ev.id, ev.etag, old.id);
    logManaged(db, userId, desiredRef(d, ev.id), "update", { ...d, moved: true }, now);
    return true;
  } catch (err) {
    if (err instanceof ProviderError) return false;
    throw err;
  }
}

// Change log references (docs/specs/support-troubleshooting.md rule 12).
const managedRef = (r: ManagedRow, eventId: string) => ({
  calendarId: r.calendar_id,
  eventId,
  key: r.key,
  kind: r.kind,
  sourceId: r.source_id,
});
const desiredRef = (d: DesiredEvent, eventId: string) => ({ ...d, eventId });
const plain = (r: ManagedRow) => ({ title: r.title, start: r.start_ms, end: r.end_ms });

async function deleteRemote(ctx: PushContext, row: ManagedRow): Promise<void> {
  if (!row.event_id) return;
  const { provider, providerCalendarId } = ctx.target(row.calendar_id);
  await provider.deleteEvent(providerCalendarId, row.event_id);
  run(
    ctx.db,
    "DELETE FROM events WHERE calendar_id = ? AND event_id = ?",
    row.calendar_id,
    row.event_id,
  );
}

function saveRow(
  db: Db,
  userId: string,
  d: DesiredEvent,
  eventId: string,
  etag: string | null,
  existingId: string | undefined,
): void {
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms,
       busy, title, description, color_id, locked, etag, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       calendar_id = excluded.calendar_id, event_id = excluded.event_id, start_ms = excluded.start_ms,
       end_ms = excluded.end_ms, busy = excluded.busy, title = excluded.title,
       description = excluded.description, color_id = excluded.color_id, etag = excluded.etag,
       extra = excluded.extra`,
    existingId ?? randomUUID(),
    userId,
    d.calendarId,
    eventId,
    d.key,
    d.kind,
    d.sourceId,
    d.start,
    d.end,
    d.busy ? 1 : 0,
    d.title,
    d.description,
    d.colorId,
    etag,
    extraOf(d),
  );
}
