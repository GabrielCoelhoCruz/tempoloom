import { signal } from "@preact/signals";
import clsx from "clsx/lite";
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addDays,
  type LocalDate,
  localToUtc,
  MINUTE,
  utcToLocal,
  weekdayOf,
} from "../../shared/time.ts";
import { clockText, hourText, timeText, weekdayText } from "../lib/format.ts";
import type { Firsts } from "../lib/glide.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { wide } from "../lib/media.ts";
import { byKeyboard } from "../lib/motion.ts";

export interface WeekEvent {
  id: string;
  start: number;
  end: number;
  title: string;
  /** "external" for events Tempoloom does not manage. */
  kind: string;
  busy: boolean;
  locked: boolean;
  movable: boolean;
  /** Preview mode: a staged new or moved event, the old place of a moved one, or a deleted one. */
  staged?: "new" | "from" | "deleted";
}

interface Props {
  days: LocalDate[];
  zone: string;
  events: WeekEvent[];
  now: number;
  onMove?: (id: string, start: number) => void;
  onSelect?: (id: string) => void;
  /** TSK-7: a range picked on free space (a drag), or a click there (end null). */
  onCreate?: (start: number, end: number | null) => void;
  /** Event ids drawn as conflicts (events-external-priority.md rule 8). */
  flagged?: ReadonlySet<string>;
  /** A second time column in this zone (timezones-home-and-travel.md rule 10). */
  extraZone?: string | null;
  /** Days that a busy all-day event uses, with its title (planning-planner.md PLN-5). */
  busyDays?: ReadonlyMap<string, string>;
  /**
   * A click or a drag on a past time (planning-task-progress.md PRG-21): the
   * start, rounded down to 15 minutes, and for a drag its length in minutes.
   */
  onPickPast?: (t: number, minutes?: number) => void;
  /** A day to mark (a link to the planner at that day). */
  focusDay?: LocalDate | null;
  /** The event open in the details panel: on touch, only this card can be dragged (MOB-8). */
  selectedId?: string | undefined;
}

/** PLN-5: a grey dashed pattern across a day with a busy all-day event. */
const BUSY_DAY = {
  backgroundImage:
    "repeating-linear-gradient(135deg, rgba(128,128,128,0.18) 0 6px, transparent 6px 14px)",
};

// LAY-43: the list of a "+N" button loads with the planner's other parts.
const MoreList = lazyComponent<{
  events: WeekEvent[];
  zone: string;
  style: Record<string, string>;
  instant: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}>(() => import("./planner-now.tsx").then((m) => m.MoreList));

const city = (z: string) => (z.split("/").at(-1) ?? z).replace(/_/g, " ");

const HOUR_PX = 48;
/** The height an event box needs for its title line and its time line (CMP-89). */
const TWO_LINES_PX = 36;
/** A box this high or more clamps its title to 2 lines (ui-refresh.md A7). */
const TALL_PX = 56;
/** A box lower than this has room for one small line only (ui-refresh.md A6). */
const TINY_PX = 20;
const SNAP_MIN = 15;
const DAY_PX = 24 * HOUR_PX;

interface Box {
  ev: WeekEvent;
  day: number;
  top: number;
  height: number;
  col: number;
  /** The columns its cluster shows (at most the cap). */
  cols: number;
  /** Its cluster folds events: the columns leave room for the "+N" lane. */
  lane: boolean;
}

/** The events of one cluster that do not fit in the cap (LAY-41): one "+N" button at the first. */
export interface More {
  day: number;
  top: number;
  events: WeekEvent[];
}

/**
 * Places events into per-day columns so overlapping events sit side by side.
 * A cluster shows at most `cap` columns; the events of the other columns fold
 * into a "+N" list (ui-refresh.md LAY-40 to LAY-42).
 */
export function layout(
  days: LocalDate[],
  zone: string,
  events: WeekEvent[],
  cap = Number.POSITIVE_INFINITY,
): { boxes: Box[]; more: More[] } {
  const boxes: Box[] = [];
  const more: More[] = [];
  days.forEach((date, day) => {
    const dayStart = localToUtc(zone, date, 0);
    const dayEnd = localToUtc(zone, addDays(date, 1), 0);
    const items = events
      .filter((e) => e.start < dayEnd && e.end > dayStart)
      .sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
    let cluster: Box[] = [];
    let clusterEnd = Number.NEGATIVE_INFINITY;
    const colEnds: number[] = [];
    const flush = () => {
      const folded = cluster.filter((b) => b.col >= cap);
      for (const b of cluster) {
        b.cols = Math.min(colEnds.length, cap);
        b.lane = folded.length > 0;
        if (b.col < cap) boxes.push(b);
      }
      const first = folded[0];
      if (first) more.push({ day, top: first.top, events: folded.map((b) => b.ev) });
      cluster = [];
      colEnds.length = 0;
    };
    for (const ev of items) {
      const s = Math.max(ev.start, dayStart);
      const e = Math.min(ev.end, dayEnd);
      if (s >= clusterEnd) flush();
      let col = colEnds.findIndex((end) => end <= s);
      if (col === -1) col = colEnds.push(e) - 1;
      else colEnds[col] = e;
      const startMin = s === dayStart ? 0 : utcToLocal(zone, s).minuteOfDay;
      const box: Box = {
        ev,
        day,
        top: (startMin / 60) * HOUR_PX,
        height: Math.max(((e - s) / 3_600_000) * HOUR_PX, 14),
        col,
        cols: 1,
        lane: false,
      };
      cluster.push(box);
      clusterEnd = Math.max(clusterEnd, e);
    }
    flush();
  });
  return { boxes, more };
}

const drag = signal<{ id: string; dx: number; dyMin: number } | null>(null);
/** The replan glide (MOT-40); it loads after the first draw, which never glides. */
let glider: typeof import("../lib/glide.ts") | undefined;
/** The card and pointer of the press in progress (MOB-12: one drag at a time). */
let pressed: { el: Element; pointer: number } | null = null;
/** The width of the "+N" lane at the inline end of a cluster that folds events (LAY-41). */
const LANE_PX = 24;
/** A range being picked on free space: day index and local minutes. */
const pick = signal<{ day: number; from: number; to: number } | null>(null);
const snapDown = (m: number) => Math.floor(m / SNAP_MIN) * SNAP_MIN;
const snapUp = (m: number) => Math.ceil(m / SNAP_MIN) * SNAP_MIN;

export function WeekView({
  days,
  zone,
  events,
  now,
  onMove,
  onSelect,
  onCreate,
  flagged,
  extraZone,
  busyDays,
  onPickPast,
  focusDay,
  selectedId,
}: Props) {
  const cap = wide.value ? 3 : 2;
  const { boxes, more } = useMemo(() => layout(days, zone, events, cap), [days, zone, events, cap]);
  /** The "+N" list that is open: its day and top. */
  const [moreOpen, setMoreOpen] = useState<string | null>(null);
  // MOT-6: a list opened from the keyboard shows at once.
  const [instant, setInstant] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open at 07:00, where the working day starts for most people.
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX;
    void import("../lib/glide.ts").then((m) => {
      glider = m;
    });
  }, []);
  // MOT-44: when the events change while the same days show, measure the cards
  // before this render draws ("first"), then glide them after it.
  const sig = events.map((e) => `${e.id}@${e.start}-${e.end}`).join();
  const shownDays = days.join();
  const lastDays = useRef(shownDays);
  // Only a new event list measures.
  const first = useMemo<Firsts | null>(
    () =>
      gridRef.current && glider && lastDays.current === shownDays && !drag.value
        ? glider.measure(gridRef.current)
        : null,
    [sig],
  );
  // The glide runs once per event list.
  useLayoutEffect(() => {
    const same = lastDays.current === shownDays;
    lastDays.current = shownDays;
    // A week that had no cards draws its first cards without motion.
    if (same && first?.size && gridRef.current) glider?.glide(gridRef.current, first);
  }, [sig]);
  const nowLocal = utcToLocal(zone, now);
  const todayIdx = days.indexOf(nowLocal.date);
  const nowTop = (nowLocal.minuteOfDay / 60) * HOUR_PX;
  // The second column reads each hour of today (or the first day shown) in the other zone.
  const ref = todayIdx >= 0 ? nowLocal.date : (days[0] as LocalDate);
  const extra = extraZone
    ? Array.from({ length: 24 }, (_, h) => utcToLocal(extraZone, localToUtc(zone, ref, h * 60)))
    : null;
  const labelCols = extra ? "48px 64px" : "48px";

  /** The pointer is on a time before now. */
  const isPast = (e: PointerEvent, date: LocalDate) => {
    const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    const m = Math.min(24 * 60, Math.max(0, ((e.clientY - top) / HOUR_PX) * 60));
    return localToUtc(zone, date, Math.floor(m / SNAP_MIN) * SNAP_MIN) < Date.now();
  };

  /** PRG-21: a click or a drag down an empty day column on a past time opens Log work. */
  const pickPast = (
    e: PointerEvent,
    date: LocalDate,
    pick: (t: number, minutes?: number) => void,
  ) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const minuteAt = (y: number) =>
      Math.min(24 * 60, Math.max(0, ((y - el.getBoundingClientRect().top) / HOUR_PX) * 60));
    const from = minuteAt(e.clientY);
    // MOB-12: a cancelled pointer (a scroll on touch) never opens Log work.
    const listen = new AbortController();
    el.addEventListener("pointercancel", () => listen.abort(), { signal: listen.signal });
    el.addEventListener(
      "pointerup",
      (u) => {
        listen.abort();
        const to = minuteAt(u.clientY);
        const lo = Math.floor(Math.min(from, to) / SNAP_MIN) * SNAP_MIN;
        const hi = Math.round(Math.max(from, to) / SNAP_MIN) * SNAP_MIN;
        const t = localToUtc(zone, date, lo);
        const room = Math.floor((Date.now() - t) / 60_000);
        if (room <= 0) return;
        // A drag into the future logs work only up to now (edge case 6).
        const dragged = hi - lo >= SNAP_MIN && Math.abs(to - from) >= SNAP_MIN / 2;
        pick(t, dragged ? Math.min(hi - lo, room) : undefined);
      },
      { signal: listen.signal },
    );
  };

  const startDrag = (e: PointerEvent, box: Box) => {
    // MOB-12: one primary pointer, one drag at a time.
    if (e.button !== 0 || !e.isPrimary || pressed?.el.hasPointerCapture(pressed.pointer)) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    pressed = { el, pointer: e.pointerId };
    // CMP-87: a pressed card is raised; it does not scale (MOT-60).
    el.classList.add("ev-pressed");
    // Fixed events open their details on a click; they cannot be dragged. On
    // touch, the first tap selects a card and only the selected card moves (MOB-8).
    const movable =
      box.ev.movable && onMove && (e.pointerType !== "touch" || box.ev.id === selectedId);
    // A drag starts after 4 px with a mouse, 10 px with a finger or a pen.
    const slop = e.pointerType === "mouse" ? 4 : 10;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const colWidth = (gridRef.current?.clientWidth ?? 700) / days.length;
    let started = false;
    let moved = false;
    const listen = new AbortController();
    const end = () => {
      listen.abort();
      pressed = null;
      el.classList.remove("ev-pressed");
      const d = drag.value;
      drag.value = null;
      return d;
    };
    const on = (type: string, fn: (p: PointerEvent) => void) =>
      el.addEventListener(type, fn as EventListener, { signal: listen.signal });
    on("pointermove", (m) => {
      started ||= Math.hypot(m.clientX - x0, m.clientY - y0) >= slop;
      if (!started || !movable) return;
      const dx = Math.round((m.clientX - x0) / colWidth);
      const dyMin = Math.round(((m.clientY - y0) / HOUR_PX) * (60 / SNAP_MIN)) * SNAP_MIN;
      if (dx !== 0 || dyMin !== 0) moved = true;
      drag.value = { id: box.ev.id, dx, dyMin };
    });
    // A click, or a move of less than one slot, selects; a swipe on a fixed card does not.
    on("pointerup", () => {
      const d = end();
      if (moved && d) {
        const local = utcToLocal(zone, box.ev.start);
        const date = addDays(local.date, d.dx);
        const minute = Math.round((local.minuteOfDay + d.dyMin) / SNAP_MIN) * SNAP_MIN;
        onMove?.(box.ev.id, localToUtc(zone, date, minute));
      } else if (movable || !started) onSelect?.(box.ev.id);
    });
    // A cancelled pointer (a scroll on touch) puts the card back.
    on("pointercancel", end);
  };

  const startPick = (e: PointerEvent, day: number) => {
    if (e.button !== 0 || !onCreate) return;
    const col = e.currentTarget as HTMLElement;
    const top = col.getBoundingClientRect().top;
    const minuteAt = (y: number) => Math.max(0, Math.min(1440, ((y - top) / HOUR_PX) * 60));
    const m0 = minuteAt(e.clientY);
    const y0 = e.clientY;
    col.setPointerCapture(e.pointerId);
    let moved = false;
    const move = (m: PointerEvent) => {
      if (Math.abs(m.clientY - y0) > 4) moved = true;
      if (!moved) return;
      const a = Math.min(m0, minuteAt(m.clientY));
      const b = Math.max(m0, minuteAt(m.clientY));
      pick.value = { day, from: snapDown(a), to: Math.max(snapDown(a) + SNAP_MIN, snapUp(b)) };
    };
    const end = () => {
      col.removeEventListener("pointermove", move);
      col.removeEventListener("pointerup", up);
      col.removeEventListener("pointercancel", end);
      const p = pick.value;
      pick.value = null;
      return p;
    };
    // A cancelled pointer (a touch pan, for example) makes no task.
    const up = () => {
      const p = end();
      const date = days[day] as LocalDate;
      if (moved && p) onCreate(localToUtc(zone, date, p.from), localToUtc(zone, date, p.to));
      else onCreate(localToUtc(zone, date, snapDown(m0)), null);
    };
    col.addEventListener("pointermove", move);
    col.addEventListener("pointerup", up);
    col.addEventListener("pointercancel", end);
  };
  const picked = pick.value;

  return (
    <div class="week">
      <div
        class="week-head"
        style={{ gridTemplateColumns: `${labelCols} repeat(${days.length}, 1fr)` }}
      >
        {extra && extraZone ? (
          <>
            <div class="zone-head" data-testid="zone-head" title={zone}>
              {city(zone)}
            </div>
            <div class="zone-head" data-testid="zone-head" title={extraZone}>
              {city(extraZone)}
            </div>
          </>
        ) : (
          <div />
        )}
        {days.map((d, i) => (
          <div
            class={clsx("day-name", i === todayIdx && "today", d === focusDay && "focus")}
            key={d}
            data-date={d}
          >
            {weekdayText(d)} {i === todayIdx ? <b>{Number(d.slice(8))}</b> : Number(d.slice(8))}
          </div>
        ))}
      </div>
      <div class="week-scroll" ref={scrollRef}>
        <div
          class="week-body"
          style={{
            height: `${DAY_PX}px`,
            ...(extra ? { gridTemplateColumns: `${labelCols} 1fr` } : {}),
          }}
        >
          <div class="hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div class="hour-label" key={h} style={{ top: `${h * HOUR_PX}px` }}>
                {h === 0 ? "" : hourText(h)}
              </div>
            ))}
            {/* CMP-141: the time now, in the hour gutter; not an hour label. */}
            {todayIdx >= 0 && (
              <div class="now-pill" style={{ top: `${nowTop}px` }}>
                {clockText(zone, now).split(" ")[0]}
              </div>
            )}
          </div>
          {extra && (
            <div class="hours extra-hours">
              {extra.map((l, h) => (
                <div
                  class="hour-label"
                  key={h}
                  data-testid="extra-hour"
                  style={{ top: `${h * HOUR_PX}px` }}
                >
                  {h === 0 ? "" : timeText(l.minuteOfDay)}
                </div>
              ))}
            </div>
          )}
          <div
            class="grid"
            ref={gridRef}
            style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}
          >
            {days.map((d, i) => {
              const busyTitle = busyDays?.get(d);
              return (
                <div
                  // LAY-34: weekends are flat gray; a busy all-day day keeps its pattern.
                  class={clsx(
                    "day-col",
                    busyTitle === undefined ? weekdayOf(d) > 5 && "day-off" : "day-busy",
                  )}
                  key={d}
                  data-date={d}
                  title={busyTitle}
                  style={busyTitle === undefined ? undefined : BUSY_DAY}
                  // A past time logs work (PRG-21), a future time makes a task (TSK-7).
                  // The toolbar's "Log work" button is the keyboard path.
                  onPointerDown={(e) =>
                    onPickPast && isPast(e, d) ? pickPast(e, d, onPickPast) : startPick(e, i)
                  }
                />
              );
            })}
            {picked && (
              <div
                class="ev ev-pick"
                data-testid="pick"
                style={{
                  top: `${(picked.from / 60) * HOUR_PX}px`,
                  height: `${((picked.to - picked.from) / 60) * HOUR_PX}px`,
                  left: `${(picked.day / days.length) * 100}%`,
                  width: `calc(${100 / days.length}% - 2px)`,
                }}
              />
            )}
            {/* CMP-140: a 1 px line across the days under the cards, today's 2 px line and its dot. */}
            {todayIdx >= 0 && <div class="now-week" style={{ top: `${nowTop}px` }} />}
            {todayIdx >= 0 && (
              <div
                class="now-line"
                style={{
                  top: `${nowTop}px`,
                  left: `${(todayIdx / days.length) * 100}%`,
                  width: `${100 / days.length}%`,
                }}
              />
            )}
            {boxes.map((b, i) => {
              const d = drag.value?.id === b.ev.id ? drag.value : null;
              const dayIdx = b.day + (d?.dx ?? 0);
              const top = b.top + ((d?.dyMin ?? 0) / 60) * HOUR_PX;
              // One column of the cluster: the day width, less the "+N" lane, shared.
              const col = `(${100 / days.length}%${b.lane ? ` - ${LANE_PX}px` : ""}) / ${b.cols}`;
              return (
                <div
                  key={`${b.ev.id}:${b.day}`}
                  class={clsx(
                    "ev",
                    `ev-${b.ev.kind}`,
                    !b.ev.busy && "ev-free",
                    b.ev.locked && "ev-locked",
                    b.ev.end <= now && "ev-past",
                    b.height < TWO_LINES_PX && "ev-short",
                    b.height < TINY_PX && "ev-tiny",
                    b.height >= TALL_PX && "ev-tall",
                    b.cols > 1 && "ev-overlap",
                    b.ev.id === selectedId && "ev-selected",
                    d && "ev-drag",
                    b.ev.staged && `ev-staged-${b.ev.staged}`,
                    flagged?.has(b.ev.id) && "ev-conflict",
                  )}
                  data-event-id={b.ev.id}
                  // MOT-44: the n-th card of this event, in day order.
                  data-box-key={`${b.ev.id}#${boxes.slice(0, i).filter((o) => o.ev.id === b.ev.id).length}`}
                  data-start={b.ev.start}
                  title={b.ev.title}
                  // CMP-82: 1 px inside its slot at the top and the bottom.
                  style={{
                    top: `${top + 1}px`,
                    height: `${b.height - 2}px`,
                    left: `calc(${(dayIdx / days.length) * 100}% + ${col} * ${b.col})`,
                    width: `calc(${col} - 2px)`,
                  }}
                  onPointerDown={(e) => startDrag(e, b)}
                >
                  <span class="ev-title" dir="auto">
                    {b.ev.title}
                  </span>
                  <span class="ev-time">
                    {clockText(zone, b.ev.start)}–{clockText(zone, b.ev.end)}
                  </span>
                  {!b.ev.busy && <span class="ev-meta">free</span>}
                </div>
              );
            })}
            {more.map((m) => {
              const n = m.events.length;
              const id = `${m.day}:${m.top}`;
              // The lane's inline end, and the side the list opens to (LAY-42, LAY-43).
              const right = `calc(${((days.length - m.day - 1) / days.length) * 100}% + 2px)`;
              return (
                <Fragment key={id}>
                  <button
                    type="button"
                    class="ev-more"
                    aria-label={n === 1 ? "1 more event" : `${n} more events`}
                    aria-expanded={moreOpen === id}
                    style={{ top: `${m.top}px`, right }}
                    onClick={(e) => {
                      setInstant(byKeyboard(e));
                      setMoreOpen(moreOpen === id ? null : id);
                    }}
                  >
                    +{n}
                  </button>
                  {moreOpen === id && (
                    <MoreList
                      events={m.events}
                      zone={zone}
                      // MOT-21: it grows from the corner next to the pill.
                      style={{
                        top: `${m.top + 24}px`,
                        ...(m.day >= days.length / 2
                          ? { right, transformOrigin: "top right" }
                          : {
                              left: `calc(${((m.day + 1) / days.length) * 100}% - ${LANE_PX}px)`,
                              transformOrigin: "top left",
                            }),
                      }}
                      instant={instant}
                      onPick={(id) => {
                        setMoreOpen(null);
                        onSelect?.(id);
                      }}
                      onClose={() => setMoreOpen(null)}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export const SNAP = SNAP_MIN * MINUTE;
