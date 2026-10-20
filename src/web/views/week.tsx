import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { addDays, type LocalDate, localToUtc, MINUTE, utcToLocal } from "../../shared/time.ts";

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
  /** Event ids drawn as conflicts (events-external-priority.md rule 8). */
  flagged?: ReadonlySet<string>;
  /** A second time column in this zone (timezones-home-and-travel.md rule 10). */
  extraZone?: string | null;
  /**
   * A click or a drag on a past time (planning-task-progress.md PRG-21): the
   * start, rounded down to 15 minutes, and for a drag its length in minutes.
   */
  onPickPast?: (t: number, minutes?: number) => void;
}

const city = (z: string) => (z.split("/").at(-1) ?? z).replace(/_/g, " ");

const HOUR_PX = 48;
const SNAP_MIN = 15;
const DAY_PX = 24 * HOUR_PX;

interface Box {
  ev: WeekEvent;
  day: number;
  top: number;
  height: number;
  col: number;
  cols: number;
}

/** Places events into per-day columns so overlapping events sit side by side. */
export function layout(days: LocalDate[], zone: string, events: WeekEvent[]): Box[] {
  const boxes: Box[] = [];
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
      const cols = colEnds.length;
      for (const b of cluster) b.cols = cols;
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
      };
      cluster.push(box);
      boxes.push(box);
      clusterEnd = Math.max(clusterEnd, e);
    }
    flush();
  });
  return boxes;
}

const drag = signal<{ id: string; dx: number; dyMin: number } | null>(null);

export function WeekView({
  days,
  zone,
  events,
  now,
  onMove,
  onSelect,
  flagged,
  extraZone,
  onPickPast,
}: Props) {
  const boxes = useMemo(() => layout(days, zone, events), [days, zone, events]);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open at 07:00, where the working day starts for most people.
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX;
  }, []);
  const nowLocal = utcToLocal(zone, now);
  const todayIdx = days.indexOf(nowLocal.date);
  // The second column reads each hour of today (or the first day shown) in the other zone.
  const ref = todayIdx >= 0 ? nowLocal.date : (days[0] as LocalDate);
  const extra = extraZone
    ? Array.from({ length: 24 }, (_, h) => utcToLocal(extraZone, localToUtc(zone, ref, h * 60)))
    : null;
  const labelCols = extra ? "56px 56px" : "56px";

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
    el.addEventListener(
      "pointerup",
      (u) => {
        const to = minuteAt(u.clientY);
        const lo = Math.floor(Math.min(from, to) / SNAP_MIN) * SNAP_MIN;
        const hi = Math.round(Math.max(from, to) / SNAP_MIN) * SNAP_MIN;
        const t = localToUtc(zone, date, lo);
        if (t >= Date.now()) return;
        pick(t, hi - lo >= SNAP_MIN && Math.abs(to - from) >= SNAP_MIN / 2 ? hi - lo : undefined);
      },
      { once: true },
    );
  };

  const startDrag = (e: PointerEvent, box: Box) => {
    if (e.button !== 0) return;
    if (!box.ev.movable || !onMove) {
      // Fixed events open their details on a click; they cannot be dragged.
      const el = e.currentTarget as HTMLElement;
      el.addEventListener("pointerup", () => onSelect?.(box.ev.id), { once: true });
      return;
    }
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const colWidth = (gridRef.current?.clientWidth ?? 700) / days.length;
    let moved = false;
    const move = (m: PointerEvent) => {
      const dx = Math.round((m.clientX - x0) / colWidth);
      const dyMin = Math.round(((m.clientY - y0) / HOUR_PX) * (60 / SNAP_MIN)) * SNAP_MIN;
      if (dx !== 0 || dyMin !== 0) moved = true;
      drag.value = { id: box.ev.id, dx, dyMin };
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      const d = drag.value;
      drag.value = null;
      if (!moved || !d) {
        onSelect?.(box.ev.id);
        return;
      }
      const local = utcToLocal(zone, box.ev.start);
      const date = addDays(local.date, d.dx);
      const minute = Math.round((local.minuteOfDay + d.dyMin) / SNAP_MIN) * SNAP_MIN;
      onMove(box.ev.id, localToUtc(zone, date, minute));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

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
          <div class={i === todayIdx ? "day-name today" : "day-name"} key={d}>
            {new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
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
                {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
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
                  {h === 0 ? "" : fmtMinute(l.minuteOfDay)}
                </div>
              ))}
            </div>
          )}
          <div
            class="grid"
            ref={gridRef}
            style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}
          >
            {days.map((d) => (
              <div
                class="day-col"
                key={d}
                data-date={d}
                // The toolbar's "Log work" button is the keyboard path.
                onPointerDown={(e) => onPickPast && pickPast(e, d, onPickPast)}
              />
            ))}
            {todayIdx >= 0 && (
              <div
                class="now-line"
                style={{
                  top: `${(nowLocal.minuteOfDay / 60) * HOUR_PX}px`,
                  left: `${(todayIdx / days.length) * 100}%`,
                  width: `${100 / days.length}%`,
                }}
              />
            )}
            {boxes.map((b) => {
              const d = drag.value?.id === b.ev.id ? drag.value : null;
              const dayIdx = b.day + (d?.dx ?? 0);
              const top = b.top + ((d?.dyMin ?? 0) / 60) * HOUR_PX;
              const width = 100 / days.length / b.cols;
              return (
                <div
                  key={`${b.ev.id}:${b.day}`}
                  class={`ev ev-${b.ev.kind}${b.ev.busy ? "" : " ev-free"}${b.ev.locked ? " ev-locked" : ""}${d ? " ev-drag" : ""}${b.ev.staged ? ` ev-staged-${b.ev.staged}` : ""}${flagged?.has(b.ev.id) ? " ev-conflict" : ""}`}
                  data-event-id={b.ev.id}
                  data-start={b.ev.start}
                  title={b.ev.title}
                  style={{
                    top: `${top}px`,
                    height: `${b.height}px`,
                    left: `calc(${(dayIdx / days.length) * 100}% + ${b.col * width}%)`,
                    width: `calc(${width}% - 2px)`,
                  }}
                  onPointerDown={(e) => startDrag(e, b)}
                >
                  <span class="ev-title">{b.ev.title}</span>
                  <span class="ev-time">
                    {fmtTime(zone, b.ev.start)}–{fmtTime(zone, b.ev.end)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtTime(zone: string, t: number): string {
  return fmtMinute(utcToLocal(zone, t).minuteOfDay);
}

function fmtMinute(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const SNAP = SNAP_MIN * MINUTE;
