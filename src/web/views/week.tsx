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
}

interface Props {
  days: LocalDate[];
  zone: string;
  events: WeekEvent[];
  now: number;
  onMove?: (id: string, start: number) => void;
  onSelect?: (id: string) => void;
}

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

export function WeekView({ days, zone, events, now, onMove, onSelect }: Props) {
  const boxes = useMemo(() => layout(days, zone, events), [days, zone, events]);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open at 07:00, where the working day starts for most people.
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX;
  }, []);
  const nowLocal = utcToLocal(zone, now);
  const todayIdx = days.indexOf(nowLocal.date);

  const startDrag = (e: PointerEvent, box: Box) => {
    if (!box.ev.movable || !onMove || e.button !== 0) return;
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
      <div class="week-head" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <div />
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
        <div class="week-body" style={{ height: `${DAY_PX}px` }}>
          <div class="hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div class="hour-label" key={h} style={{ top: `${h * HOUR_PX}px` }}>
                {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
          </div>
          <div
            class="grid"
            ref={gridRef}
            style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}
          >
            {days.map((d) => (
              <div class="day-col" key={d} />
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
                  class={`ev ev-${b.ev.kind}${b.ev.busy ? "" : " ev-free"}${b.ev.locked ? " ev-locked" : ""}${d ? " ev-drag" : ""}`}
                  data-event-id={b.ev.id}
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
  const m = utcToLocal(zone, t).minuteOfDay;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const SNAP = SNAP_MIN * MINUTE;
