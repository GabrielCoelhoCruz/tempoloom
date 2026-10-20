// The scheduling engine: plan(snapshot) -> placements and report.
// Rule ids (SCH-, DEF-, TSK-) refer to docs/specs/planning-scheduler.md and the item specs.
import {
  addDays,
  DAY,
  HOUR,
  type LocalDate,
  localToUtc,
  MINUTE,
  utcToLocal,
  weekdayOf,
} from "../shared/time.ts";
import { attends, awayBlocks, blockingIntervals, hasTag, TAG_FOCUS } from "./blocking.ts";
import { hoursToTimeSet } from "./hours.ts";
import type {
  BufferFilter,
  BufferItem,
  Comparison,
  CurrentPlacement,
  ExternalEvent,
  FocusItem,
  HabitFrequency,
  HabitItem,
  Level,
  MeetingFrequency,
  MeetingItem,
  OverloadItem,
  Placement,
  PlacementKind,
  Plan,
  ReasonCode,
  ReportEntry,
  Snapshot,
  TaskItem,
} from "./model.ts";
import { type Interval, TimeSet } from "./timeset.ts";

const LEVELS: readonly Level[] = [1, 2, 3, 4];
const ADAPTIVE_BUSY_AHEAD = 12 * HOUR;
const COOLDOWN: Record<Snapshot["chunkCooldown"], number> = {
  none: 15 * MINUTE,
  "30m": 30 * MINUTE,
  "1h": HOUR,
  "2h": 2 * HOUR,
  "4h": 4 * HOUR,
  "once-per-day": 15 * MINUTE,
};

interface Ctx {
  s: Snapshot;
  step: number;
  earliest: number;
  end: number;
  breakMs: number;
  /** External blocking time plus locked and started managed events. */
  fixed: TimeSet;
  /** Time away: busy all-day and out-of-office events (events-out-of-office.md). */
  away: TimeSet;
  /** Free time for task and habit demands (break gaps applied). */
  freeTH: TimeSet;
  /** Free time for focus and buffer demands. */
  freeOther: TimeSet;
  hours: Map<string, TimeSet>;
  placements: Placement[];
  report: ReportEntry[];
  /** Keys of locked or started placements, already in `placements`. */
  fixedKeys: Set<string>;
  dismissed: Set<string>;
  current: Map<string, CurrentPlacement>;
  /** Free time each task saw before its own chunks (for DEF-11). */
  taskSeen: Map<string, TimeSet>;
  /** Free time in an occurrence's window, without the occurrence itself (for DEF-23). */
  habitSeen: Map<string, TimeSet>;
  /** MEET-02 rules 9-11: the automatic moves each meeting has left in this run. */
  meetingMoves: Map<string, number>;
}

const ceilTo = (t: number, step: number) => Math.ceil(t / step) * step;
const floorTo = (t: number, step: number) => Math.floor(t / step) * step;
const len = (i: Interval) => i.end - i.start;

const kindOf = (key: string): PlacementKind => key.slice(0, key.indexOf(":")) as PlacementKind;

function hoursSet(ctx: Ctx, id: string): TimeSet {
  let set = ctx.hours.get(id);
  if (!set) {
    set = hoursToTimeSet(ctx.s.hours[id] ?? {}, ctx.s.zone, ctx.earliest, ctx.end);
    ctx.hours.set(id, set);
  }
  return set;
}

function minus(set: TimeSet, ranges: Iterable<Interval>): TimeSet {
  const out = set.clone();
  for (const r of ranges) out.subtract(r);
  return out;
}

/** True when a block of `length` fits on the grid inside one interval of the set. */
function fits(set: TimeSet, length: number, step: number): boolean {
  for (const i of set.intervals()) if (ceilTo(i.start, step) + length <= i.end) return true;
  return false;
}

function occupy(ctx: Ctx, iv: Interval, kind: PlacementKind): void {
  ctx.freeOther.subtract(iv);
  const pad = kind === "task" || kind === "habit" ? ctx.breakMs : 0;
  ctx.freeTH.subtract({ start: iv.start - pad, end: iv.end + pad });
}

function init(s: Snapshot): Ctx {
  const step = s.stepMinutes * MINUTE;
  const earliest = ceilTo(s.now, step);
  const end = s.windowEnd;
  const breakMs = s.breakMinutes * MINUTE;
  const items = new Set<string>([
    ...s.tasks.map((t) => `task:${t.id}`),
    ...s.habits.map((h) => `habit:${h.id}`),
    ...s.meetings.map((m) => `meeting:${m.id}`),
    ...s.buffers.map((b) => `buffer:${b.id}`),
    ...s.focus.map((f) => `focus:${f.id}`),
    ...(s.overloads ?? []).map((o) => `focus:${o.id}`),
  ]);
  const external = blockingIntervals(s.events);
  const fixedManaged = s.current.filter(
    (c) =>
      c.end > s.now && (c.locked || c.start <= s.now) && items.has(`${kindOf(c.key)}:${c.itemId}`),
  );
  const window = TimeSet.from(end > earliest ? [{ start: earliest, end }] : []);
  const fixed = TimeSet.from([...external, ...fixedManaged]);
  const freeOther = minus(window, fixed.intervals());
  const freeTH = minus(window, external);
  for (const c of fixedManaged) {
    const pad = ["task", "habit"].includes(kindOf(c.key)) ? breakMs : 0;
    freeTH.subtract({ start: c.start - pad, end: c.end + pad });
  }
  const ctx: Ctx = {
    s,
    step,
    earliest,
    end,
    breakMs,
    fixed,
    away: TimeSet.from(awayBlocks(s.events)),
    freeTH,
    freeOther,
    hours: new Map(),
    placements: [],
    report: [],
    fixedKeys: new Set(),
    dismissed: new Set(s.dismissedKeys ?? []),
    current: new Map(s.current.map((c) => [c.key, c])),
    taskSeen: new Map(),
    habitSeen: new Map(),
    meetingMoves: new Map(),
  };
  for (const c of fixedManaged) {
    const kind = kindOf(c.key);
    const task = kind === "task" ? s.tasks.find((t) => t.id === c.itemId) : undefined;
    ctx.fixedKeys.add(c.key);
    ctx.placements.push({
      key: c.key,
      kind,
      itemId: c.itemId,
      start: c.start,
      end: c.end,
      busy: true,
      locked: c.locked,
      conflict: false,
      afterDue: task?.dueAt != null && c.end > task.dueAt,
    });
  }
  return ctx;
}

// ---------------------------------------------------------------- reasons

function baseReason(
  ctx: Ctx,
  hours: TimeSet,
  lower: number,
  upper: number,
  minLength: number,
): ReasonCode | null {
  if (lower >= ctx.end) return "outside-window";
  const h = hours.clip(lower, Math.min(upper, ctx.end));
  if (h.total() === 0) return "no-hours";
  if (!fits(h, minLength, ctx.step)) return "too-long-for-hours";
  if (minus(h, ctx.away.intervals()).total() === 0) return "away";
  return null;
}

function report(ctx: Ctx, entry: Omit<ReportEntry, "missingMinutes">): void {
  ctx.report.push({ ...entry, missingMinutes: entry.requiredMinutes - entry.placedMinutes });
}

// ---------------------------------------------------------------- tasks

function effectiveLevel(ctx: Ctx, t: TaskItem): Level {
  const { s } = ctx;
  if (s.urgencyMode === "priority-only" || t.dueAt === null) return t.level;
  const lift = (n: number) => Math.max(1, t.level - n) as Level;
  if (s.urgencyMode === "due-date") return t.dueAt - s.now <= 48 * HOUR ? lift(1) : t.level;
  const avail = minus(
    hoursSet(ctx, t.hours).clip(Math.max(s.now, t.startAfter), t.dueAt),
    ctx.fixed.intervals(),
  ).total();
  const ratio = avail / Math.max(1, t.remainingMinutes * MINUTE);
  return ratio < 1.25 ? lift(2) : ratio < 2 ? lift(1) : t.level;
}

interface ChunkRules {
  min: number;
  max: number;
  gap: number;
  oncePerDay: boolean;
}

const dayStartOf = (ctx: Ctx, t: number) =>
  localToUtc(ctx.s.zone, utcToLocal(ctx.s.zone, t).date, 0);
const nextDayStart = (ctx: Ctx, t: number) =>
  localToUtc(ctx.s.zone, addDays(utcToLocal(ctx.s.zone, t).date, 1), 0);

/**
 * A need splits into chunks within the bounds when k = ceil(need / max)
 * chunks of the minimum fit in it. Else the rest after max-length chunks is
 * one chunk shorter than the minimum (TSK-13).
 */
const splits = (need: number, r: ChunkRules) =>
  need <= 0 || Math.ceil(need / r.max) * r.min <= need;

/** SCH-90: fills free intervals in time order with chunks. Returns chunks and the unplaced rest. */
function greedyChunks(
  ctx: Ctx,
  free: TimeSet,
  need: number,
  r: ChunkRules,
  usedDays: Set<number>,
): { chunks: Interval[]; missing: number } {
  const rest = need - (Math.ceil(need / r.max) - 1) * r.max;
  if (!splits(need, r) && rest < need) {
    // No split (TSK-13): place the max-length chunks first, then the rest as
    // one short chunk in the first room that holds it. A replan keeps the
    // full chunks and looks for the rest the same way, so the plans agree.
    const full = greedyChunks(ctx, free, need - rest, r, usedDays);
    if (full.missing > 0) return { chunks: full.chunks, missing: full.missing + rest };
    const left = minus(
      free,
      full.chunks.map((c) => ({ start: c.start - r.gap, end: c.end + r.gap })),
    );
    const tail = greedyChunks(ctx, left, rest, r, usedDays);
    return { chunks: [...full.chunks, ...tail.chunks], missing: tail.missing };
  }
  const chunks: Interval[] = [];
  const step = ctx.step;
  // TSK-14: the next chunk starts no earlier than the last end plus the
  // cooldown, also in a later free interval or on the next day.
  let floor = -Infinity;
  for (const iv of free.intervals()) {
    let cursor = ceilTo(Math.max(iv.start, floor), step);
    while (need > 0 && cursor < iv.end) {
      if (r.oncePerDay && usedDays.has(dayStartOf(ctx, cursor))) {
        cursor = ceilTo(nextDayStart(ctx, cursor), step);
        continue;
      }
      const room = floorTo(iv.end - cursor, step);
      let length = Math.min(r.max, need, room);
      if (splits(need, r)) {
        // Take the most that still leaves k - 1 chunks of at least the
        // minimum, and keep the rest splittable when the room is short.
        const k = Math.ceil(need / r.max);
        length = Math.min(length, need - (k - 1) * r.min);
        if (!splits(need - length, r)) length = need - Math.ceil((need - length) / r.max) * r.min;
      }
      if (length < r.min && !(need < r.min && length === need)) break;
      if (length <= 0) break;
      chunks.push({ start: cursor, end: cursor + length });
      need -= length;
      floor = cursor + length + r.gap;
      if (r.oncePerDay) usedDays.add(dayStartOf(ctx, cursor));
      cursor = ceilTo(r.oncePerDay ? Math.max(floor, nextDayStart(ctx, cursor)) : floor, step);
    }
    if (need <= 0) break;
  }
  return { chunks, missing: need };
}

function placeTask(ctx: Ctx, t: TaskItem): void {
  const { s } = ctx;
  const prefix = `task:${t.id}:`;
  const mine = s.current.filter((c) => c.key.startsWith(prefix) && c.end > s.now);
  const fixedMine = mine.filter((c) => ctx.fixedKeys.has(c.key));
  const total = t.remainingMinutes * MINUTE;
  const need = total - fixedMine.reduce((a, c) => a + len(c), 0);
  if (need <= 0) return;
  const rules: ChunkRules = {
    min: t.minChunkMinutes * MINUTE,
    max: t.maxChunkMinutes * MINUTE,
    gap: COOLDOWN[s.chunkCooldown],
    oncePerDay: s.chunkCooldown === "once-per-day",
  };
  const lower = Math.max(ctx.earliest, ceilTo(t.startAfter, ctx.step));
  const free = minus(hoursSet(ctx, t.hours).intersect(ctx.freeTH).clip(lower, ctx.end), [
    ...t.exclusions,
    ...fixedMine.map((c) => ({ start: c.start - rules.gap, end: c.end + rules.gap })),
  ]);
  ctx.taskSeen.set(t.id, free.clone());
  const fixedDays = new Set(fixedMine.map((c) => dayStartOf(ctx, c.start)));

  const attempt = (sticky: CurrentPlacement[]) => {
    const local = free.clone();
    const usedDays = new Set(fixedDays);
    const kept: { key: string; iv: Interval }[] = [];
    let keptLen = 0;
    for (const c of sticky) {
      const rest = need - keptLen;
      if (rest <= 0) break;
      let iv: Interval = { start: c.start, end: c.end };
      if (len(iv) > rest) {
        if (rest < rules.min) continue;
        iv = { start: c.start, end: c.start + rest };
      }
      const l = len(iv);
      const okLength =
        ((l >= rules.min && l <= rules.max) || (l < rules.min && l === rest && rest < rules.min)) &&
        (splits(rest - l, rules) || !splits(rest, rules));
      const day = dayStartOf(ctx, iv.start);
      if (!okLength || !local.contains(iv) || (rules.oncePerDay && usedDays.has(day))) continue;
      kept.push({ key: c.key, iv });
      keptLen += l;
      usedDays.add(day);
      local.subtract({ start: iv.start - rules.gap, end: iv.end + rules.gap });
    }
    const fresh = greedyChunks(ctx, local, need - keptLen, rules, usedDays);
    return { kept, fresh: fresh.chunks, missing: fresh.missing };
  };

  const sticky = t.changed
    ? []
    : mine
        .filter((c) => !ctx.fixedKeys.has(c.key))
        // A short chunk (TSK-13) is the rest, so it is kept last.
        .sort(
          (a, b) =>
            Number(len(a) < rules.min) - Number(len(b) < rules.min) ||
            a.start - b.start ||
            a.key.localeCompare(b.key),
        );
  let result = attempt(sticky);
  const late = (r: typeof result) =>
    r.missing > 0 ||
    (t.dueAt !== null &&
      [...r.kept.map((k) => k.iv), ...r.fresh].some((c) => c.end > (t.dueAt as number)));
  if (sticky.length > 0 && t.dueAt !== null && late(result)) result = attempt([]);

  // New chunks first reuse the keys of dropped chunks, so the push step moves
  // those events instead of deleting and creating them.
  const index = (key: string) => Number(key.slice(prefix.length));
  const keptKeys = new Set(result.kept.map((k) => k.key));
  const dropped = mine
    .filter((c) => !ctx.fixedKeys.has(c.key) && !keptKeys.has(c.key))
    .map((c) => c.key)
    .sort((a, b) => index(a) - index(b));
  let next = mine.reduce((m, c) => Math.max(m, index(c.key) + 1), 0);
  const freshKeys = result.fresh.map(() => dropped.shift() ?? `${prefix}${next++}`);

  const chunks = [
    ...result.kept.map((k) => ({ key: k.key, iv: k.iv })),
    ...result.fresh.map((iv, i) => ({ key: freshKeys[i] as string, iv })),
  ];
  for (const c of chunks) {
    occupy(ctx, c.iv, "task");
    ctx.placements.push({
      key: c.key,
      kind: "task",
      itemId: t.id,
      start: c.iv.start,
      end: c.iv.end,
      busy: false,
      locked: false,
      conflict: false,
      afterDue: t.dueAt !== null && c.iv.end > t.dueAt,
    });
  }

  const placed = total - result.missing;
  const anyLate =
    t.dueAt !== null &&
    ctx.placements.some((p) => p.kind === "task" && p.itemId === t.id && p.afterDue);
  if (result.missing > 0) {
    const minLength = Math.min(rules.min, need);
    let reason = baseReason(ctx, hoursSet(ctx, t.hours), lower, ctx.end, minLength);
    if (!reason) {
      const fixedOnly = minus(hoursSet(ctx, t.hours).clip(lower, ctx.end), [
        ...ctx.fixed.intervals(),
        ...t.exclusions,
      ]);
      reason =
        greedyChunks(ctx, fixedOnly, need, rules, new Set(fixedDays)).missing > 0
          ? "no-space-fixed"
          : "no-space-priority";
    }
    report(ctx, {
      itemKind: "task",
      itemId: t.id,
      demandKey: `task:${t.id}`,
      requiredMinutes: t.remainingMinutes,
      placedMinutes: placed / MINUTE,
      status: placed > 0 ? "partial" : "unplaced",
      reason,
    });
  } else if (anyLate) {
    report(ctx, {
      itemKind: "task",
      itemId: t.id,
      demandKey: `task:${t.id}`,
      requiredMinutes: t.remainingMinutes,
      placedMinutes: t.remainingMinutes,
      status: "after-due",
      reason: "after-due",
    });
  }
}

// ---------------------------------------------------------------- habits

interface Occurrence {
  date: LocalDate;
  alternatives: LocalDate[];
  periodStart: LocalDate;
  periodEnd: LocalDate;
}

function weekStartDate(ctx: Ctx, date: LocalDate): LocalDate {
  const wd = weekdayOf(date);
  const back = (wd - ctx.s.weekStart + 7) % 7;
  return addDays(date, -back);
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Index `i` of a period counted from the anchor period is on an every-`every` cadence. */
const onCadence = (i: number, every: number) => mod(i, every) === 0;

const monthIndex = (d: LocalDate) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));

/**
 * The habit's occurrences. With an interval above 1 (custom frequency), only
 * the periods of its unit (day, week or month) on the cadence from the anchor.
 */
function habitOccurrences(ctx: Ctx, h: HabitItem): Occurrence[] {
  const f = h.frequency;
  const out = frequencyOccurrences(ctx, h);
  const every = f.interval ?? 1;
  if (every <= 1) return out;
  const anchor = f.anchor ?? h.starting ?? utcToLocal(ctx.s.zone, h.createdAt).date;
  const index = (d: LocalDate): number =>
    f.period === "daily"
      ? dayDiff(d, anchor)
      : f.period === "weekly"
        ? dayDiff(d, weekStartDate(ctx, anchor)) / 7
        : monthIndex(d) - monthIndex(anchor);
  return out.filter((o) => onCadence(index(o.periodStart), every));
}

function frequencyOccurrences(ctx: Ctx, h: HabitItem): Occurrence[] {
  const frequency = h.frequency;
  const { s } = ctx;
  const first = utcToLocal(s.zone, ctx.earliest).date;
  const last = utcToLocal(s.zone, ctx.end - 1).date;
  const hasHours = (d: LocalDate) => (s.hours[h.hours]?.[weekdayOf(d)]?.length ?? 0) > 0;
  const allowed = (d: LocalDate) => !h.starting || d >= h.starting;
  const out: Occurrence[] = [];
  if (frequency.period === "monthly") {
    return monthlyOccurrences(frequency, first, last, hasHours, allowed);
  }
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!allowed(d)) continue;
    if (frequency.period === "daily") {
      if (hasHours(d)) out.push({ date: d, alternatives: [], periodStart: d, periodEnd: d });
      continue;
    }
    const days = frequency.days;
    if (!days.includes(weekdayOf(d))) continue;
    const ws = weekStartDate(ctx, d);
    const alternatives: LocalDate[] = [];
    for (let i = 0; i < 7; i++) {
      const a = addDays(ws, i);
      if (a !== d && !days.includes(weekdayOf(a)) && hasHours(a) && allowed(a))
        alternatives.push(a);
    }
    alternatives.sort(
      (a, b) => Math.abs(dayDiff(a, d)) - Math.abs(dayDiff(b, d)) || (a < b ? -1 : 1),
    );
    out.push({ date: d, alternatives, periodStart: ws, periodEnd: addDays(ws, 6) });
  }
  return out;
}

type MonthlyFrequency = Extract<HabitFrequency, { period: "monthly" }>;

/**
 * The date a monthly habit selects in the month of `month` (YYYY-MM-01), or
 * null. Tempoloom decision: day 31 in a 30-day month is the month's last day;
 * a 5th weekday that does not exist selects nothing.
 */
export function monthlyDate(month: LocalDate, f: MonthlyFrequency): LocalDate | null {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const on = (d: number) => `${month.slice(0, 8)}${String(d).padStart(2, "0")}`;
  if ("dayOfMonth" in f) return on(Math.min(f.dayOfMonth, daysIn));
  let d = 1 + ((f.weekday - weekdayOf(month) + 7) % 7);
  if (f.nth === "last") {
    while (d + 7 <= daysIn) d += 7;
    return on(d);
  }
  d += (f.nth - 1) * 7;
  return d <= daysIn ? on(d) : null;
}

/** Rule 15 (proposed): a monthly occurrence may move up to 6 days later, inside its month. */
function monthlyOccurrences(
  f: MonthlyFrequency,
  first: LocalDate,
  last: LocalDate,
  hasHours: (d: LocalDate) => boolean,
  allowed: (d: LocalDate) => boolean,
): Occurrence[] {
  const out: Occurrence[] = [];
  for (let month = `${first.slice(0, 8)}01`; month <= last; ) {
    const date = monthlyDate(month, f);
    const next = addDays(month, 32).slice(0, 8);
    const monthEnd = addDays(`${next}01`, -1);
    if (date && date >= first && date <= last && allowed(date)) {
      const alternatives: LocalDate[] = [];
      for (let i = 1; i <= 6; i++) {
        const a = addDays(date, i);
        if (a <= monthEnd && hasHours(a)) alternatives.push(a);
      }
      out.push({ date, alternatives, periodStart: month, periodEnd: monthEnd });
    }
    month = `${next}01`;
  }
  return out;
}

const dayDiff = (a: LocalDate, b: LocalDate) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);

function dayWindow(ctx: Ctx, hoursId: string, date: LocalDate): TimeSet {
  return hoursSet(ctx, hoursId).clip(
    localToUtc(ctx.s.zone, date, 0),
    localToUtc(ctx.s.zone, addDays(date, 1), 0),
  );
}

/** Cost of a start beyond the fragmentation shift: ranks after every start within it. */
const OUT_OF_SHIFT = Number.MAX_SAFE_INTEGER;

/**
 * Rule 23 of teams-policies.md: the fragmented time that a block at [t, t + l)
 * adds inside the free interval `iv`. A gap counts only between two busy times,
 * so an edge of the hours `window` bounds no gap (rule 21).
 */
function fragmentCost(
  window: TimeSet,
  minBlock: number,
  iv: Interval,
): (t: number, l: number) => number {
  const ws = window.intervals();
  const busyBefore = !ws.some((w) => w.start === iv.start);
  const busyAfter = !ws.some((w) => w.end === iv.end);
  const short = (gap: number, bounded: boolean) => (bounded && gap > 0 && gap < minBlock ? gap : 0);
  const before = short(len(iv), busyBefore && busyAfter);
  return (t, l) => short(t - iv.start, busyBefore) + short(iv.end - t - l, busyAfter) - before;
}

/** SCH-91: nearest start to the ideal time; shrinks per the defense mode. */
function searchHabit(
  ctx: Ctx,
  h: HabitItem,
  free: TimeSet,
  date: LocalDate,
  window?: TimeSet,
): Interval | null {
  const ideal = localToUtc(ctx.s.zone, date, h.rescheduled?.[date] ?? h.idealMinute);
  const lengths: number[] = [];
  for (let m = h.maxMinutes; m >= h.minMinutes; m -= 15) lengths.push(m * MINUTE);
  if (lengths.at(-1) !== h.minMinutes * MINUTE) lengths.push(h.minMinutes * MINUTE);
  const frag = ctx.s.fragmentation;
  const starts = (length: number) => {
    if (frag && window) {
      // Within the member's flexibility, the start that adds the least fragmented time.
      const out: { t: number; cost: number }[] = [];
      const shift = frag.maxShiftMinutes * MINUTE;
      for (const iv of free.intervals()) {
        const cost = fragmentCost(window, frag.minBlockMinutes * MINUTE, iv);
        for (let t = ceilTo(iv.start, ctx.step); t + length <= iv.end; t += ctx.step) {
          out.push({ t, cost: Math.abs(t - ideal) > shift ? OUT_OF_SHIFT : cost(t, length) });
        }
      }
      return out
        .sort(
          (a, b) => a.cost - b.cost || Math.abs(a.t - ideal) - Math.abs(b.t - ideal) || a.t - b.t,
        )
        .map((x) => x.t);
    }
    const out: number[] = [];
    for (const iv of free.intervals()) {
      for (let t = ceilTo(iv.start, ctx.step); t + length <= iv.end; t += ctx.step) out.push(t);
    }
    return out.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal) || a - b);
  };
  if (h.defense === "always-free") {
    for (const t of starts(h.minMinutes * MINUTE)) {
      for (const l of lengths)
        if (free.contains({ start: t, end: t + l })) return { start: t, end: t + l };
    }
    return null;
  }
  for (const l of lengths) {
    const [t] = starts(l);
    if (t !== undefined) return { start: t, end: t + l };
  }
  return null;
}

function reservedWordHit(ctx: Ctx, h: HabitItem, window: TimeSet): boolean {
  if (h.reservedWords.length === 0) return false;
  const words = h.reservedWords.map((w) => w.toLowerCase()).filter(Boolean);
  return ctx.s.events.some(
    (e) =>
      window.overlaps({ start: e.start, end: e.end }) &&
      words.some((w) => e.title.toLowerCase().includes(w)),
  );
}

function placeHabit(ctx: Ctx, h: HabitItem): void {
  const { s } = ctx;
  const done = new Set((s.past ?? []).map((p) => p.key));
  for (const occ of habitOccurrences(ctx, h)) {
    const key = `habit:${h.id}:${occ.date}`;
    if (
      done.has(key) ||
      ctx.fixedKeys.has(key) ||
      ctx.dismissed.has(key) ||
      h.skips.includes(occ.date)
    ) {
      continue;
    }
    const fullWindow = dayWindow(ctx, h.hours, occ.date);
    // Rule 30: a rescheduled occurrence stays on its day, nearest the chosen time.
    const moved = h.rescheduled?.[occ.date] !== undefined;
    const days = moved ? [occ.date] : [occ.date, ...occ.alternatives];
    const windows = days.map((d) => dayWindow(ctx, h.hours, d));
    if (windows.every((w) => w.total() === 0)) continue;
    const required = h.maxMinutes;
    const periodLower = Math.max(ctx.earliest, localToUtc(s.zone, occ.periodStart, 0));
    const periodUpper = localToUtc(s.zone, addDays(occ.periodEnd, 1), 0);
    if (reservedWordHit(ctx, h, fullWindow)) {
      report(ctx, {
        itemKind: "habit",
        itemId: h.id,
        demandKey: key,
        requiredMinutes: required,
        placedMinutes: 0,
        status: "unplaced",
        reason: "reserved-word",
      });
      continue;
    }
    const frees = windows.map((w) => minus(w.intersect(ctx.freeTH), h.exclusions));
    let chosen: { iv: Interval; dayIdx: number } | null = null;
    const cur = ctx.current.get(key);
    if (cur && !h.changed && !moved) {
      const l = len(cur);
      const okLen = l >= h.minMinutes * MINUTE && l <= h.maxMinutes * MINUTE;
      const dayIdx = frees.findIndex((f) => f.contains(cur));
      if (okLen && dayIdx >= 0) chosen = { iv: { start: cur.start, end: cur.end }, dayIdx };
    }
    for (let i = 0; !chosen && i < days.length; i++) {
      const iv = searchHabit(ctx, h, frees[i] as TimeSet, days[i] as LocalDate, windows[i]);
      if (iv) chosen = { iv, dayIdx: i };
    }
    if (chosen) {
      ctx.habitSeen.set(key, minus(frees[chosen.dayIdx] as TimeSet, [chosen.iv]));
      occupy(ctx, chosen.iv, "habit");
      ctx.placements.push({
        key,
        kind: "habit",
        itemId: h.id,
        start: chosen.iv.start,
        end: chosen.iv.end,
        busy: false,
        locked: false,
        conflict: false,
        afterDue: false,
      });
      continue;
    }
    const allWindows = TimeSet.from(windows.flatMap((w) => [...w.intervals()]));
    let reason = baseReason(ctx, allWindows, periodLower, periodUpper, h.minMinutes * MINUTE);
    if (!reason) {
      const fixedOnly = minus(allWindows, [...ctx.fixed.intervals(), ...h.exclusions]);
      reason = fits(fixedOnly, h.minMinutes * MINUTE, ctx.step)
        ? "no-space-priority"
        : "no-space-fixed";
    }
    // events-out-of-office.md rule 2: on a day fully away the occurrence is skipped,
    // never a conflict. Decision: the same holds when away time covers all of the
    // habit's hours that day but not the whole day, because rule 12 forbids any
    // managed item on away time and the habit has no other time that day.
    if (h.whenUnplaceable === "keep_as_conflict" && reason !== "away") {
      const iv =
        cur && !h.changed
          ? { start: cur.start, end: cur.end }
          : searchHabit(ctx, { ...h, defense: "always-busy" }, fullWindow, occ.date);
      if (iv) {
        ctx.placements.push({
          key,
          kind: "habit",
          itemId: h.id,
          start: iv.start,
          end: iv.end,
          busy: true,
          locked: false,
          conflict: true,
          afterDue: false,
        });
        report(ctx, {
          itemKind: "habit",
          itemId: h.id,
          demandKey: key,
          requiredMinutes: required,
          placedMinutes: 0,
          status: "conflict",
          reason,
        });
        continue;
      }
    }
    report(ctx, {
      itemKind: "habit",
      itemId: h.id,
      demandKey: key,
      requiredMinutes: required,
      placedMinutes: 0,
      status: "unplaced",
      reason,
    });
  }
}

// ---------------------------------------------------------------- meetings

interface Period {
  start: LocalDate;
  days: LocalDate[];
  ideal: LocalDate[];
}

/** The day N periods count from: `starting`, or else the day the meeting was created. */
export const meetingAnchor = (zone: string, m: { starting: LocalDate | null; createdAt: number }) =>
  m.starting ?? utcToLocal(zone, m.createdAt).date;

/**
 * Rule 10 and the period terms: the start of the period that holds `date`, or
 * null when `date` is in a week or month that the meeting skips (every N weeks
 * or months). Periods count from `anchor` (meetingAnchor), so they stay the same
 * from one run to the next. The scheduler and the adopted-series log both use it.
 */
export function meetingPeriodStart(
  f: MeetingFrequency,
  date: LocalDate,
  weekStart: 1 | 7,
  anchor: LocalDate,
): LocalDate | null {
  if (f.period === "daily") return addDays(date, -mod(dayDiff(date, anchor), f.everyDays ?? 1));
  if (f.period === "monthly") {
    const month = `${date.slice(0, 8)}01`;
    return onCadence(monthIndex(month) - monthIndex(anchor), f.everyMonths ?? 1) ? month : null;
  }
  const week = (d: LocalDate) => addDays(d, -((weekdayOf(d) - weekStart + 7) % 7));
  const ws = week(date);
  return onCadence(dayDiff(ws, week(anchor)) / 7, f.everyWeeks) ? ws : null;
}

function meetingPeriods(ctx: Ctx, m: MeetingItem): Period[] {
  const { s } = ctx;
  const first = utcToLocal(s.zone, ctx.earliest).date;
  const last = utcToLocal(s.zone, ctx.end - 1).date;
  const from = m.starting && m.starting > first ? m.starting : first;
  const anchor = meetingAnchor(s.zone, m);
  const startOf = (d: LocalDate) => meetingPeriodStart(m.frequency, d, s.weekStart, anchor);
  const inRange = (start: LocalDate, n: number) => {
    const days: LocalDate[] = [];
    for (let i = 0; i < n; i++) {
      const d = addDays(start, i);
      if (d >= from && d <= last) days.push(d);
    }
    return days;
  };
  const out: Period[] = [];
  const f = m.frequency;
  if (f.period === "daily") {
    const every = f.everyDays ?? 1;
    for (let ps = startOf(from) as LocalDate; ps <= last; ps = addDays(ps, every)) {
      const days = inRange(ps, every);
      if (days.length > 0) out.push({ start: ps, days, ideal: days.filter((d) => d === ps) });
    }
    return out;
  }
  if (f.period === "monthly") {
    for (let month = `${from.slice(0, 8)}01`; month <= last; ) {
      const next = `${addDays(month, 32).slice(0, 8)}01`;
      const ideal = monthlyDate(
        month,
        "nth" in f
          ? { period: "monthly", nth: f.nth, weekday: f.weekday }
          : { period: "monthly", dayOfMonth: f.dayOfMonth },
      );
      const days = inRange(month, dayDiff(next, month));
      // Tempoloom decision (meetings-flexible.md, monthly ideal day): a month without
      // its ideal day has no occurrence, as for habits; a month whose ideal day is
      // before today or `starting` gets no new one, and keeps one already placed.
      // Rule 20: a month whose ideal day is past the planning window waits for it.
      const keep =
        ideal !== null &&
        ideal <= last &&
        (ideal >= from || ctx.current.has(`meeting:${m.id}:${month}`));
      if (startOf(month) && days.length > 0 && keep)
        out.push({ start: month, days, ideal: days.filter((d) => d === ideal) });
      month = next;
    }
    return out;
  }
  for (let ws = weekStartDate(ctx, from); ws <= last; ws = addDays(ws, 7)) {
    if (!startOf(ws)) continue;
    const days = inRange(ws, 7);
    out.push({ start: ws, days, ideal: days.filter((d) => f.idealDays.includes(weekdayOf(d))) });
  }
  return out;
}

/** MEET-03 rule 2: a start whose local minute of the hour is in the set. */
function startAllowed(ctx: Ctx, m: MeetingItem, date: LocalDate): (t: number) => boolean {
  if (!m.startMinutes || m.startMinutes.length === 4) return () => true;
  const allowed = new Set(m.startMinutes);
  const dayStart = localToUtc(ctx.s.zone, date, 0);
  return (t) => allowed.has(Math.floor((t - dayStart) / MINUTE) % 60);
}

/**
 * The distance of a day from the ideal: in days from the nearest ideal day of
 * the period (0 on an ideal day). So a monthly meeting whose ideal day is full
 * goes to the nearest day with room; the time distance only ranks starts of one day.
 */
function dayDistanceOf(frees: { date: LocalDate; ideal: boolean }[]): (date: LocalDate) => number {
  const ideal = frees.filter((f) => f.ideal).map((f) => f.date);
  return (date) => (ideal.length ? Math.min(...ideal.map((d) => Math.abs(dayDiff(d, date)))) : 0);
}

/**
 * Rules 16-17: the full length first, then an ideal day, then the nearest day,
 * then nearest the ideal time. A fragmentation policy ranks the added
 * fragmented time before the time distance, within the member's flexibility.
 */
function searchMeeting(
  ctx: Ctx,
  m: MeetingItem,
  frees: { date: LocalDate; free: TimeSet; ideal: boolean; window: TimeSet }[],
): Interval | null {
  const dayDistance = dayDistanceOf(frees);
  const frag = ctx.s.fragmentation;
  const shift = (frag?.maxShiftMinutes ?? 0) * MINUTE;
  for (let l = m.durationMinutes; l >= m.shortestMinutes; l -= 5) {
    let best: { t: number; ideal: boolean; days: number; dist: number; cost: number } | null = null;
    for (const { date, free, ideal, window } of frees) {
      const days = dayDistance(date);
      if (best && (best.ideal ? !ideal || days > best.days : !ideal && days > best.days)) continue;
      const target = localToUtc(ctx.s.zone, date, m.idealMinute);
      const allowed = startAllowed(ctx, m, date);
      for (const iv of free.intervals()) {
        const added = frag ? fragmentCost(window, frag.minBlockMinutes * MINUTE, iv) : null;
        for (let t = ceilTo(iv.start, ctx.step); t + l * MINUTE <= iv.end; t += ctx.step) {
          if (!allowed(t)) continue;
          const dist = Math.abs(t - target);
          const cost = added ? (dist > shift ? OUT_OF_SHIFT : added(t, l * MINUTE)) : 0;
          if (
            !best ||
            (ideal && !best.ideal) ||
            (ideal === best.ideal &&
              (days < best.days ||
                (days === best.days &&
                  (cost < best.cost ||
                    (cost === best.cost &&
                      (dist < best.dist || (dist === best.dist && t < best.t)))))))
          )
            best = { t, ideal, days, dist, cost };
        }
      }
    }
    if (best) return { start: best.t, end: best.t + l * MINUTE };
  }
  return null;
}

/** MEET-02 rule 11: up to 3 other starts for a flagged occurrence, best first. */
function suggestMeeting(
  ctx: Ctx,
  m: MeetingItem,
  frees: { date: LocalDate; free: TimeSet; ideal: boolean }[],
): Interval[] {
  const dayDistance = dayDistanceOf(frees);
  for (let l = m.durationMinutes; l >= m.shortestMinutes; l -= 5) {
    const found: { t: number; ideal: boolean; days: number; dist: number }[] = [];
    for (const { date, free, ideal } of frees) {
      const target = localToUtc(ctx.s.zone, date, m.idealMinute);
      const days = dayDistance(date);
      const allowed = startAllowed(ctx, m, date);
      for (const iv of free.intervals())
        for (let t = ceilTo(iv.start, ctx.step); t + l * MINUTE <= iv.end; t += ctx.step)
          if (allowed(t)) found.push({ t, ideal, days, dist: Math.abs(t - target) });
    }
    if (found.length === 0) continue;
    found.sort(
      (a, b) =>
        Number(b.ideal) - Number(a.ideal) || a.days - b.days || a.dist - b.dist || a.t - b.t,
    );
    return found.slice(0, 3).map((f) => ({ start: f.t, end: f.t + l * MINUTE }));
  }
  return [];
}

/** Rule 18: half the length of the period that starts on `start`. */
function halfPeriod(f: MeetingFrequency, start: LocalDate): number {
  if (f.period === "daily") return ((f.everyDays ?? 1) * DAY) / 2;
  if (f.period === "weekly") return (f.everyWeeks * 7 * DAY) / 2;
  let end = start;
  for (let i = 0; i < (f.everyMonths ?? 1); i++) end = `${addDays(end, 32).slice(0, 8)}01`;
  return (dayDiff(end, start) * DAY) / 2;
}

/**
 * True when `date` is an ideal day of its period: the period start for a daily
 * meeting; for a monthly one, the ideal day of the period's first month.
 */
export function onIdealDay(
  zone: string,
  weekStart: 1 | 7,
  m: MeetingItem,
  date: LocalDate,
): boolean {
  const f = m.frequency;
  if (f.period === "weekly") return f.idealDays.includes(weekdayOf(date));
  const anchor = meetingAnchor(zone, m);
  if (f.period === "daily") return meetingPeriodStart(f, date, weekStart, anchor) === date;
  let month = `${date.slice(0, 8)}01`;
  for (let i = 1; i < (f.everyMonths ?? 1) && !meetingPeriodStart(f, month, weekStart, anchor); i++)
    month = `${addDays(month, -1).slice(0, 8)}01`;
  return (
    monthlyDate(
      month,
      "nth" in f
        ? { period: "monthly", nth: f.nth, weekday: f.weekday }
        : { period: "monthly", dayOfMonth: f.dayOfMonth },
    ) === date
  );
}

/**
 * Rule 18 (Tempoloom decision on the Proposed rule): the latest start of an
 * occurrence before the period, from an earlier plan or this one, when it
 * moved away from its ideal day; null otherwise.
 */
function previousStart(ctx: Ctx, m: MeetingItem, key: string, periodStart: number): number | null {
  let prev =
    m.previousStart !== undefined && m.previousStart < periodStart ? m.previousStart : null;
  for (const p of ctx.placements)
    if (p.kind === "meeting" && p.itemId === m.id && p.key !== key && p.start < periodStart)
      prev = Math.max(prev ?? p.start, p.start);
  return prev === null ||
    onIdealDay(ctx.s.zone, ctx.s.weekStart, m, utcToLocal(ctx.s.zone, prev).date)
    ? null
    : prev;
}

/** `boosted`: place only the boosted period (MEET-02 rule 16); else every other period. */
function placeMeeting(ctx: Ctx, m: MeetingItem, boosted = false): void {
  const { s } = ctx;
  const done = new Set((s.past ?? []).map((p) => p.key));
  const attendeeWindow = m.attendeeWindow ? TimeSet.from(m.attendeeWindow) : null;
  const required = m.durationMinutes;
  const periods = m.periods ? new Set(m.periods) : null;
  const manual = new Set(m.manualKeys ?? []);
  // One budget for the boosted pass and the other periods of the run.
  const movesLeft = () => ctx.meetingMoves.get(m.id) ?? m.movesLeft ?? Number.POSITIVE_INFINITY;
  for (const period of meetingPeriods(ctx, m)) {
    const key = `meeting:${m.id}:${period.start}`;
    if (done.has(key) || ctx.fixedKeys.has(key) || ctx.dismissed.has(key)) continue;
    if (periods && !periods.has(period.start)) continue;
    if (boosted !== (m.boost?.period === period.start)) continue;
    const own = period.days.map((d) => dayWindow(ctx, m.hours, d));
    if (own.every((w) => w.total() === 0)) continue;
    const windows = attendeeWindow ? own.map((w) => w.intersect(attendeeWindow)) : own;
    const cur = ctx.current.get(key);
    const blocked = [...m.attendeeBusy, ...m.exclusions];
    const frees = period.days.map((date, i) => ({
      date,
      ideal: period.ideal.includes(date),
      free: minus((windows[i] as TimeSet).intersect(ctx.freeOther), blocked),
      window: windows[i] as TimeSet,
    }));
    // MEET-02 rule 8: an automatic move keeps the lead time.
    const lead = cur ? ctx.earliest + m.leadMinutes * MINUTE : ctx.earliest;
    const open = frees.map((f) => ({ ...f, free: f.free.clip(lead, ctx.end) }));
    // Rule 18: skip starts less than half a period after the previous occurrence,
    // when another start exists.
    const prev = previousStart(ctx, m, key, localToUtc(s.zone, period.start, 0));
    const notBefore = prev === null ? null : prev + halfPeriod(m.frequency, period.start);
    let spaced: Interval | null | undefined;
    const spacedSlot = () => {
      if (spaced === undefined)
        spaced =
          notBefore === null
            ? null
            : searchMeeting(
                ctx,
                m,
                open.map((f) => ({ ...f, free: f.free.clip(notBefore, ctx.end) })),
              );
      return spaced;
    };
    let chosen: Interval | null = null;
    if (cur && !m.changed) {
      const l = len(cur);
      const okLen = l >= m.shortestMinutes * MINUTE && l <= m.durationMinutes * MINUTE;
      // An occurrence moved by hand keeps its time (MEET-02 rule 19).
      const spacedOk =
        notBefore === null || manual.has(key) || cur.start >= notBefore || !spacedSlot();
      if (okLen && spacedOk && frees.some((f) => f.free.contains(cur)))
        chosen = { start: cur.start, end: cur.end };
    }
    const found = chosen ? null : (spacedSlot() ?? searchMeeting(ctx, m, open));
    if (found && cur && !m.changed && movesLeft() <= 0) {
      // MEET-02 rules 9-11: a move is possible but none is left; keep the time, flag it, suggest others.
      occupy(ctx, cur, "meeting");
      ctx.placements.push({
        key,
        kind: "meeting",
        itemId: m.id,
        start: cur.start,
        end: cur.end,
        busy: true,
        locked: false,
        conflict: true,
        afterDue: false,
      });
      report(ctx, {
        itemKind: "meeting",
        itemId: m.id,
        demandKey: key,
        requiredMinutes: required,
        placedMinutes: 0,
        status: "conflict",
        reason: m.moveLimit === 0 ? "policy-none" : "budget-reached",
        suggestions: suggestMeeting(ctx, m, frees),
      });
      continue;
    }
    if (!chosen) chosen = found;
    if (chosen && cur && !m.changed && (chosen.start !== cur.start || chosen.end !== cur.end))
      ctx.meetingMoves.set(m.id, movesLeft() - 1);
    if (chosen) {
      const day = frees.find((f) => f.free.contains(chosen))?.free ?? TimeSet.empty();
      ctx.habitSeen.set(key, minus(day, [chosen]));
      occupy(ctx, chosen, "meeting");
      ctx.placements.push({
        key,
        kind: "meeting",
        itemId: m.id,
        start: chosen.start,
        end: chosen.end,
        busy: true,
        locked: false,
        conflict: false,
        afterDue: false,
      });
      continue;
    }
    const all = TimeSet.from(windows.flatMap((w) => [...w.intervals()]));
    const lower = Math.max(ctx.earliest, localToUtc(s.zone, period.days[0] as LocalDate, 0));
    const upper = localToUtc(s.zone, addDays(period.days.at(-1) as LocalDate, 1), 0);
    let reason: ReasonCode | null =
      all.total() === 0
        ? "no-hours-overlap"
        : baseReason(ctx, all, lower, upper, m.shortestMinutes * MINUTE);
    if (!reason) {
      const fixedOnly = minus(all, [...ctx.fixed.intervals(), ...blocked]);
      reason = fits(fixedOnly, m.shortestMinutes * MINUTE, ctx.step)
        ? "no-space-priority"
        : "no-space-fixed";
    }
    if (m.whenUnplaceable === "keep_as_conflict") {
      // MEET-02 rule 13: stay at the current time, or else at the ideal time.
      const date = period.ideal[0] ?? (period.days[0] as LocalDate);
      const start = localToUtc(s.zone, date, m.idealMinute);
      const iv =
        cur && !m.changed
          ? { start: cur.start, end: cur.end }
          : { start, end: start + m.durationMinutes * MINUTE };
      ctx.placements.push({
        key,
        kind: "meeting",
        itemId: m.id,
        start: iv.start,
        end: iv.end,
        busy: true,
        locked: false,
        conflict: true,
        afterDue: false,
      });
    }
    report(ctx, {
      itemKind: "meeting",
      itemId: m.id,
      demandKey: key,
      requiredMinutes: required,
      placedMinutes: 0,
      status: m.whenUnplaceable === "keep_as_conflict" ? "conflict" : "unplaced",
      reason,
    });
  }
}

// ---------------------------------------------------------------- buffers

function compare(op: Comparison, a: number, b: number): boolean {
  if (op === ">") return a > b;
  if (op === "<") return a < b;
  return op === ">=" ? a >= b : op === "<=" ? a <= b : a === b;
}

/** An attendee matches a full address, or any address at an "@domain" value. */
function hasPerson(e: ExternalEvent, people: string[]): boolean {
  const attendees = (e.attendees ?? []).map((a) => a.toLowerCase());
  return people.some((raw) => {
    const p = raw.trim().toLowerCase();
    return p.startsWith("@") ? attendees.some((a) => a.endsWith(p)) : attendees.includes(p);
  });
}

/**
 * buffers-travel.md rule 5: the flight category, which the user sets by hand or
 * the tag or a flight title gives (categoryOf).
 */
export function isFlight(e: ExternalEvent): boolean {
  return e.category === "flight";
}

export function hasAddress(e: ExternalEvent): boolean {
  const loc = e.location.trim();
  return !/^https?:\/\//i.test(loc) && (loc.match(/,/g)?.length ?? 0) >= 2;
}

/**
 * A travel buffer goes around an event with an address or #tl_travel, but not
 * around a flight (it gets airport time) or a #tl_trip event without
 * #tl_travel, which is travel itself (events-tags.md rule 18).
 */
function wantsTravelBuffer(e: ExternalEvent): boolean {
  if (isFlight(e)) return false;
  if (hasTag(e, "#tl_travel")) return true;
  return hasAddress(e) && !hasTag(e, "#tl_trip");
}

export function matchesFilter(f: BufferFilter, e: ExternalEvent): boolean {
  if (f.categories && !(e.category && f.categories.includes(e.category))) return false;
  if (f.flight && !isFlight(e)) return false;
  if (f.travel && !wantsTravelBuffer(e)) return false;
  if (f.text) {
    const fields = f.text.fields.length > 0 ? f.text.fields : (["title"] as const);
    const hay = fields.map((k) => e[k].toLowerCase());
    if (!f.text.values.some((v) => hay.some((h) => h.includes(v.toLowerCase())))) return false;
  }
  if (
    f.participants &&
    !compare(f.participants.op, Math.max(1, e.attendeeCount), f.participants.value)
  ) {
    return false;
  }
  if (f.length && !compare(f.length.op, (e.end - e.start) / MINUTE, f.length.minutes)) return false;
  if (
    f.exactTitle !== undefined &&
    e.title.trim().toLowerCase() !== f.exactTitle.trim().toLowerCase()
  ) {
    return false;
  }
  if (f.tags && !f.tags.some((t) => hasTag(e, t))) return false;
  if (f.people && f.people.length > 0 && !hasPerson(e, f.people)) return false;
  return true;
}

/**
 * Rule 7 and the calendar scope: the anchors of a buffer in [from, to). Mirror
 * copies count as their calendars show them (buffers-travel.md rule 13), unless
 * their source event is an anchor itself. With `runLongerThanMinutes`, each run
 * of back-to-back matching events longer than that is one anchor.
 */
export function bufferAnchors(
  events: ExternalEvent[],
  copies: ExternalEvent[],
  b: Pick<BufferItem, "filter" | "calendarScope">,
  from: number,
  to: number,
): ExternalEvent[] {
  const scope = b.calendarScope ?? null;
  const usable = (e: ExternalEvent) =>
    e.busy &&
    !e.allDay &&
    e.selfResponse !== "declined" &&
    e.end > e.start &&
    e.end > from &&
    e.start < to &&
    (scope === null || e.calendarId === scope) &&
    matchesFilter(b.filter, e);
  const direct = events.filter(usable);
  const sources = new Set(direct.map((e) => `${e.calendarId}:${e.start}:${e.end}`));
  const anchors = [
    ...direct,
    ...copies.filter((c) => usable(c) && !sources.has(`${c.mirrorSource}:${c.start}:${c.end}`)),
  ].sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
  const limit = b.filter.runLongerThanMinutes;
  if (!limit) return anchors;
  const runs: ExternalEvent[] = [];
  for (const a of anchors) {
    const last = runs.at(-1);
    if (last && a.start <= last.end) last.end = Math.max(last.end, a.end);
    else runs.push({ ...a, id: `run:${a.id}` });
  }
  return runs.filter((r) => r.end - r.start > limit * MINUTE);
}

function placeBuffer(ctx: Ctx, b: BufferItem): void {
  const anchors = bufferAnchors(ctx.s.events, ctx.s.mirrorCopies ?? [], b, ctx.earliest, ctx.end);
  for (const a of anchors) {
    const sides = b.side === "both" ? (["before", "after"] as const) : [b.side];
    for (const side of sides) {
      const key = `buffer:${b.id}:${a.id}:${side}`;
      if (ctx.fixedKeys.has(key) || ctx.dismissed.has(key)) continue;
      // Rule 14: a length the user set for this anchor occurrence wins.
      const kept = ctx.s.bufferLengths?.[key];
      const iv =
        side === "before"
          ? { start: a.start - (kept ?? b.minutesBefore) * MINUTE, end: a.start }
          : { start: a.end, end: a.end + (kept ?? b.minutesAfter) * MINUTE };
      if (len(iv) <= 0 || iv.start < ctx.earliest || iv.end > ctx.end) continue;
      const ok = ctx.freeOther.contains(iv);
      if (!ok && b.onConflict === "remove") continue;
      if (ok) occupy(ctx, iv, "buffer");
      ctx.placements.push({
        key,
        kind: "buffer",
        itemId: b.id,
        start: iv.start,
        end: iv.end,
        busy: ok ? b.busy : true,
        locked: false,
        conflict: !ok,
        afterDue: false,
      });
    }
  }
}

// ---------------------------------------------------------------- focus

function countedMinutes(ctx: Ctx, f: FocusItem, dayRange: Interval): number {
  const { s } = ctx;
  const window = hoursSet(ctx, f.hours).clip(dayRange.start, dayRange.end);
  const work = new Set(s.workHours);
  const taskHours = new Map(s.tasks.map((t) => [t.id, t.hours]));
  const habitWork = new Map(s.habits.map((h) => [h.id, h.work ?? work.has(h.hours)]));
  const counts = (p: { key: string; itemId: string }) => {
    const kind = kindOf(p.key);
    if (kind === "focus") return true;
    if (kind === "task") return work.has(taskHours.get(p.itemId) ?? "");
    if (kind === "habit") return habitWork.get(p.itemId) ?? false;
    return false;
  };
  const ranges: Interval[] = [
    ...ctx.placements.filter((p) => !p.conflict && counts(p)),
    ...(s.past ?? []).filter(counts),
    ...s.events.filter((e) => !e.allDay && (e.eventType === "focusTime" || hasTag(e, TAG_FOCUS))),
  ].map((p) => ({ start: p.start, end: p.end }));
  return window.intersect(TimeSet.from(ranges)).total();
}

function placeFocus(ctx: Ctx, f: FocusItem): void {
  const { s } = ctx;
  const minB = f.minBlockMinutes * MINUTE;
  const maxB = f.maxBlockMinutes * MINUTE;
  const firstDate = utcToLocal(s.zone, ctx.earliest).date;
  const lastDate = utcToLocal(s.zone, ctx.end - 1).date;
  for (let ws = weekStartDate(ctx, firstDate); ws <= lastDate; ws = addDays(ws, 7)) {
    const days: LocalDate[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      if (d >= firstDate && d <= lastDate && dayWindow(ctx, f.hours, d).total() > 0) days.push(d);
    }
    if (days.length === 0) continue;
    const range = (d: LocalDate): Interval => ({
      start: localToUtc(s.zone, d, 0),
      end: localToUtc(s.zone, addDays(d, 1), 0),
    });
    const weekRange = {
      start: localToUtc(s.zone, ws, 0),
      end: localToUtc(s.zone, addDays(ws, 7), 0),
    };
    let need = f.weeklyGoalMinutes * MINUTE - countedMinutes(ctx, f, weekRange);
    if (need <= 0) continue;
    const dayTotal = (d: LocalDate) => countedMinutes(ctx, f, range(d));
    const freeOn = (d: LocalDate) =>
      minus(dayWindow(ctx, f.hours, d).intersect(ctx.freeOther), f.exclusions);
    // Block indexes per day already used by this item's current events.
    const used = new Map<LocalDate, Set<number>>();
    const indexes = (d: LocalDate) => {
      let idx = used.get(d);
      if (!idx) {
        idx = new Set(
          s.current
            .filter((c) => c.key.startsWith(`focus:${f.id}:${d}:`))
            .map((c) => Number(c.key.split(":").at(-1))),
        );
        used.set(d, idx);
      }
      return idx;
    };
    const keyFor = (d: LocalDate) => {
      const idx = indexes(d);
      let n = 0;
      while (idx.has(n)) n++;
      idx.add(n);
      return `focus:${f.id}:${d}:${n}`;
    };
    const put = (key: string, iv: Interval) => {
      occupy(ctx, iv, "focus");
      ctx.placements.push({
        key,
        kind: "focus",
        itemId: f.id,
        start: iv.start,
        end: iv.end,
        busy: f.busy,
        locked: false,
        conflict: false,
        afterDue: false,
      });
      need -= len(iv);
    };
    if (f.mode === "reactive") {
      // Rules 8-9: wait while the free time left is more than the missing goal;
      // then turn all of it into focus, without the block and daily limits (rule 10).
      const blocks = days.flatMap((d) =>
        alignedBlocks(ctx, freeOn(d), minB).map((iv) => ({ d, iv })),
      );
      if (blocks.reduce((a, b) => a + len(b.iv), 0) > need) continue;
      for (const b of blocks) put(keyFor(b.d), b.iv);
    }
    if (!f.changed && f.mode !== "reactive") {
      const sticky = s.current
        .filter(
          (c) =>
            c.key.startsWith(`focus:${f.id}:`) &&
            !ctx.fixedKeys.has(c.key) &&
            c.start >= weekRange.start &&
            c.start < weekRange.end,
        )
        .sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
      for (const c of sticky) {
        const d = c.key.split(":")[2] as LocalDate;
        const l = len(c);
        if (need < l || l < minB || l > maxB) continue;
        if (!freeOn(d).contains(c) || dayTotal(d) + l > f.dailyMaxMinutes * MINUTE) continue;
        indexes(d);
        put(c.key, { start: c.start, end: c.end });
      }
    }
    for (const capOf of f.mode === "reactive"
      ? []
      : [
          (d: LocalDate) => f.dailyMinMinutes * MINUTE - dayTotal(d),
          (d: LocalDate) => f.dailyMaxMinutes * MINUTE - dayTotal(d),
        ]) {
      for (const d of days) {
        for (;;) {
          const cap = capOf(d);
          if (need < minB || cap < minB) break;
          const best = [...freeOn(d).intervals()]
            .map((i) => ({ start: ceilTo(i.start, ctx.step), end: i.end }))
            .filter((i) => len(i) >= minB)
            .sort((a, b) => len(b) - len(a) || a.start - b.start)[0];
          if (!best) break;
          const l = floorTo(Math.min(len(best), cap, need, maxB), ctx.step);
          if (l < minB) break;
          put(keyFor(d), { start: best.start, end: best.start + l });
        }
      }
    }
    if (need > 0) {
      const required = f.weeklyGoalMinutes;
      const missing = Math.ceil(need / MINUTE);
      const reason =
        baseReason(
          ctx,
          hoursSet(ctx, f.hours),
          Math.max(ctx.earliest, weekRange.start),
          weekRange.end,
          minB,
        ) ??
        (fits(
          minus(hoursSet(ctx, f.hours).clip(weekRange.start, weekRange.end), ctx.fixed.intervals()),
          minB,
          ctx.step,
        )
          ? "no-space-priority"
          : "no-space-fixed");
      report(ctx, {
        itemKind: "focus",
        itemId: f.id,
        demandKey: `focus:${f.id}:${ws}`,
        requiredMinutes: required,
        placedMinutes: required - missing,
        status: missing < required ? "partial" : "unplaced",
        reason,
      });
    }
  }
}

/** Free intervals on the step grid that are at least `min` long. */
function alignedBlocks(ctx: Ctx, free: TimeSet, min: number): Interval[] {
  return free
    .intervals()
    .map((i) => ({ start: ceilTo(i.start, ctx.step), end: floorTo(i.end, ctx.step) }))
    .filter((i) => len(i) >= min);
}

// ---------------------------------------------------------------- meeting overload

/**
 * focus-time.md rule 11 (Tempoloom decision): busy events with another
 * attendee that the user organized, accepted or marked maybe; booking-link
 * meetings and flexible meetings. Overlaps count once.
 */
function meetingTime(ctx: Ctx): TimeSet {
  const isMeeting = (e: ExternalEvent) =>
    !e.allDay &&
    e.busy &&
    (e.bookedViaLink ||
      (e.attendeeCount >= 2 &&
        attends(e) &&
        (e.organizerSelf || e.selfResponse === "accepted" || e.selfResponse === "tentative")));
  return TimeSet.from([
    ...ctx.s.events.filter(isMeeting),
    ...ctx.placements.filter((p) => p.kind === "meeting" && !p.conflict),
  ]);
}

/** Rules 12-15: protects the free time of each day on which a meeting limit is reached. */
function placeOverload(ctx: Ctx, o: OverloadItem, meetings: TimeSet): void {
  const { s } = ctx;
  const minB = o.minBlockMinutes * MINUTE;
  const first = utcToLocal(s.zone, ctx.earliest).date;
  const last = utcToLocal(s.zone, ctx.end - 1).date;
  const dayStart = (d: LocalDate) => localToUtc(s.zone, d, 0);
  const onDay = (d: LocalDate) => meetings.clip(dayStart(d), dayStart(addDays(d, 1))).total();
  const workday = (d: LocalDate) => (s.hours[o.hours]?.[weekdayOf(d)]?.length ?? 0) > 0;
  const afterHeavyDay = (d: LocalDate) => {
    if (o.heavyDayMinutes === null) return true;
    for (let i = 1; i <= 7; i++) {
      const prev = addDays(d, -i);
      if (workday(prev)) return onDay(prev) >= o.heavyDayMinutes * MINUTE;
    }
    return false;
  };
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (!workday(d)) continue;
    const daily =
      o.dailyMaxMinutes !== null && onDay(d) >= o.dailyMaxMinutes * MINUTE && afterHeavyDay(d);
    const weekly =
      o.weeklyMaxMinutes !== null &&
      meetings.clip(dayStart(weekStartDate(ctx, d)), dayStart(addDays(d, 1))).total() >=
        o.weeklyMaxMinutes * MINUTE;
    if (!daily && !weekly) continue;
    const free = minus(dayWindow(ctx, o.hours, d).intersect(ctx.freeOther), o.exclusions);
    let n = 0;
    for (const iv of alignedBlocks(ctx, free, minB)) {
      // Locked events of this automation keep their keys.
      while (ctx.fixedKeys.has(`focus:${o.id}:${d}:${n}`)) n++;
      occupy(ctx, iv, "focus");
      ctx.placements.push({
        key: `focus:${o.id}:${d}:${n++}`,
        kind: "focus",
        itemId: o.id,
        start: iv.start,
        end: iv.end,
        busy: true,
        locked: false,
        conflict: false,
        afterDue: false,
      });
    }
  }
}

// ---------------------------------------------------------------- status

function setStatus(ctx: Ctx): void {
  const { s } = ctx;
  const tasks = new Map(s.tasks.map((t) => [t.id, t]));
  const habits = new Map(s.habits.map((h) => [h.id, h]));
  const byTask = new Map<string, Placement[]>();
  for (const p of ctx.placements) {
    if (p.kind === "task" && !ctx.fixedKeys.has(p.key)) {
      const list = byTask.get(p.itemId) ?? [];
      list.push(p);
      byTask.set(p.itemId, list);
    }
  }
  for (const [id, chunks] of byTask) {
    const t = tasks.get(id);
    const seen = ctx.taskSeen.get(id);
    if (!t || !seen) continue;
    const due = t.dueAt;
    if (due === null) continue;
    if (chunks.some((c) => c.afterDue)) {
      for (const c of chunks) c.busy = true;
      continue;
    }
    const need = chunks.reduce((a, c) => a + (c.end - c.start), 0);
    const rules: ChunkRules = {
      min: t.minChunkMinutes * MINUTE,
      max: t.maxChunkMinutes * MINUTE,
      gap: COOLDOWN[s.chunkCooldown],
      oncePerDay: s.chunkCooldown === "once-per-day",
    };
    // Once-per-day: the days of locked and started chunks stay used.
    const fixedDays = ctx.placements
      .filter((p) => p.kind === "task" && p.itemId === id && ctx.fixedKeys.has(p.key))
      .filter((p) => p.end > s.now)
      .map((p) => dayStartOf(ctx, p.start));
    for (const c of chunks) {
      const alt = greedyChunks(
        ctx,
        minus(seen.clip(ctx.earliest, due), [c]),
        need,
        rules,
        new Set(fixedDays),
      );
      c.busy = alt.missing > 0;
    }
  }
  const meetings = new Map(s.meetings.map((m) => [m.id, m]));
  for (const p of ctx.placements) {
    if (p.kind !== "meeting" || p.conflict || ctx.fixedKeys.has(p.key)) continue;
    const m = meetings.get(p.itemId);
    if (!m || m.defense !== "adaptive") {
      p.busy = m?.defense !== "free";
      continue;
    }
    const others = ctx.habitSeen.get(p.key) ?? TimeSet.empty();
    p.busy =
      p.start - s.now < ADAPTIVE_BUSY_AHEAD || !fits(others, m.shortestMinutes * MINUTE, ctx.step);
  }
  for (const p of ctx.placements) {
    if (p.kind !== "habit" || p.conflict || ctx.fixedKeys.has(p.key)) continue;
    const h = habits.get(p.itemId);
    if (!h) continue;
    if (h.defense !== "adaptive") {
      p.busy = h.defense === "always-busy";
      continue;
    }
    const others = ctx.habitSeen.get(p.key) ?? TimeSet.empty();
    p.busy =
      p.start - s.now < ADAPTIVE_BUSY_AHEAD || !fits(others, h.minMinutes * MINUTE, ctx.step);
  }
}

// ---------------------------------------------------------------- entry point

const taskKey = (a: TaskItem, b: TaskItem) =>
  (a.dueAt ?? Number.POSITIVE_INFINITY) - (b.dueAt ?? Number.POSITIVE_INFINITY) ||
  b.remainingMinutes - a.remainingMinutes ||
  a.createdAt - b.createdAt ||
  a.id.localeCompare(b.id);

type Automation =
  | { kind: "meeting"; item: MeetingItem; boosted?: boolean }
  | { kind: "buffer"; item: BufferItem }
  | { kind: "habit"; item: HabitItem };
// Inside one level and rank, meetings go first (meetings-flexible.md rule 23).
const KIND_ORDER = { meeting: 0, buffer: 1, habit: 2 } as const;

export function plan(s: Snapshot): Plan {
  const ctx = init(s);
  const effective = new Map(s.tasks.map((t) => [t.id, effectiveLevel(ctx, t)]));
  for (const level of LEVELS) {
    const autos: Automation[] = [
      ...s.meetings
        .filter((m) => m.level === level)
        .map((item) => ({ kind: "meeting" as const, item })),
      // MEET-02 rule 16: the boosted period of a meeting goes at the boosted level.
      ...s.meetings
        .filter((m) => m.boost?.level === level)
        .map((item) => ({ kind: "meeting" as const, item, boosted: true })),
      ...s.buffers
        .filter((b) => b.level === level)
        .map((item) => ({ kind: "buffer" as const, item })),
      ...s.habits
        .filter((h) => h.level === level)
        .map((item) => ({ kind: "habit" as const, item })),
    ].sort(
      (a, b) =>
        a.item.rank - b.item.rank ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.item.createdAt - b.item.createdAt ||
        a.item.id.localeCompare(b.item.id),
    );
    for (const a of autos) {
      if (a.kind === "meeting") placeMeeting(ctx, a.item, a.boosted);
      else if (a.kind === "buffer") placeBuffer(ctx, a.item);
      else placeHabit(ctx, a.item);
    }
    if (level === 1) {
      const queue = s.tasks
        .filter((t) => t.nextUpRank !== null)
        .sort((a, b) => (a.nextUpRank ?? 0) - (b.nextUpRank ?? 0) || taskKey(a, b));
      for (const t of queue) placeTask(ctx, t);
    }
    const band = s.tasks
      .filter((t) => t.nextUpRank === null && effective.get(t.id) === level)
      .sort(taskKey);
    for (const t of band) placeTask(ctx, t);
  }
  // Both focus automations come after every other item, in their P4 rank order;
  // at one rank the meeting overload goes first (focus edge case 5).
  const overloads = s.overloads ?? [];
  const meetings = overloads.length > 0 ? meetingTime(ctx) : TimeSet.empty();
  const focus = [
    ...overloads.map((o) => ({ item: o, type: 0, place: () => placeOverload(ctx, o, meetings) })),
    ...s.focus.map((f) => ({ item: f, type: 1, place: () => placeFocus(ctx, f) })),
  ].sort(
    (a, b) =>
      a.item.rank - b.item.rank ||
      a.type - b.type ||
      a.item.createdAt - b.item.createdAt ||
      a.item.id.localeCompare(b.item.id),
  );
  for (const f of focus) f.place();
  setStatus(ctx);
  return {
    placements: ctx.placements.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key)),
    report: ctx.report.sort(
      (a, b) =>
        a.itemKind.localeCompare(b.itemKind) ||
        a.itemId.localeCompare(b.itemId) ||
        a.demandKey.localeCompare(b.demandKey),
    ),
  };
}
