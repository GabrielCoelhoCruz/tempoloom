// The planner's event details (planning-planner.md PLN-11, PLN-21), in the right
// column. They load on the first click on an event, so the planner's cold load
// stays small (ui-refresh.md TST-12).
import { useEffect } from "preact/hooks";
import { CATEGORIES } from "../../scheduler/categories.ts";
import type { CalendarRef, PlannerEvent } from "../../server/api/planner.ts";
import { utcToLocal } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { calendarList, displayName, loadCalendars } from "../lib/calendars.tsx";
import { CATEGORY_LABELS } from "../lib/categories.ts";
import { clockText, formatWhen } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { sidePanel } from "../lib/planner-signals.ts";
import "./parts.css";

const EventExtras = lazyComponent<{ event: PlannerEvent; onDone: () => void }>(() =>
  import("./planner-now.tsx").then((m) => m.EventExtras),
);
// Event actions and the meeting actions load on demand.
const EventActions = lazyComponent<{
  event: PlannerEvent;
  zone: string;
  run: (fn: () => Promise<unknown>) => void;
  close: () => void;
}>(() => import("./planner-extras.tsx").then((m) => m.EventActions));
const MeetingActions = lazyComponent<{
  event: PlannerEvent;
  run: (fn: () => Promise<unknown>) => void;
  close: () => void;
}>(() => import("./planner-meeting.tsx").then((m) => m.MeetingActions));

/** One note per reason the level of an external event stays P1. */
const LEVEL_FIXED_NOTES: Record<NonNullable<PlannerEvent["levelFixed"]>, string> = {
  "booking-link": "Meetings booked through a booking link stay P1: they are fixed.",
  mirrored: "Mirrored events stay P1: their copies on other calendars count as P1.",
  "other-calendar":
    "Events from other calendars stay P1: only events on your main calendar can change.",
};

/** A calendar's name as the calendar list shows it; the server's name until that list loads. */
function calendarName(ref: CalendarRef): string {
  const row = calendarList.value.find((c) => c.id === ref.id);
  return row ? displayName(row, calendarList.value) : ref.name;
}

/** `run` changes the plan and draws the week again; `close` closes the details. */
export function EventDetails({
  event: selected,
  zone: z,
  run,
  close,
}: {
  event: PlannerEvent;
  zone: string;
  run: (fn: () => Promise<unknown>) => void;
  close: () => void;
}) {
  // The details name calendars as the calendar list does; that list loads on the first open.
  const external = selected.kind === "external";
  useEffect(() => {
    if (external && calendarList.value.length === 0) void loadCalendars().catch(() => {});
  }, [external]);
  return (
    <aside class="drawer" data-testid="event-drawer">
      {/* CMP-124: the title and Close in one row. */}
      <div class="drawer-head">
        <h2 dir="auto">{selected.title}</h2>
        <button
          type="button"
          class="sm ghost"
          onClick={() => {
            close();
            sidePanel.value = null;
          }}
        >
          Close
        </button>
      </div>
      <div class="status">
        {formatWhen(z, selected.start)} –{" "}
        {utcToLocal(z, selected.end - 1).date === utcToLocal(z, selected.start).date
          ? clockText(z, selected.end)
          : formatWhen(z, selected.end)}
      </div>
      <div class="status">
        {selected.kind} · {selected.busy ? "busy" : "free"}
        {selected.locked && selected.kind !== "external" ? " · locked" : ""}
        {selected.category ? ` · ${CATEGORY_LABELS[selected.category]}` : ""}
      </div>
      {selected.calendar && (
        <div class="status" data-testid="event-source">
          Calendar: {calendarName(selected.calendar)}
        </div>
      )}
      {selected.copies && selected.copies.length > 0 && (
        <div class="status" data-testid="event-copies">
          Copied to: {selected.copies.map(calendarName).join(", ")}
        </div>
      )}
      {!selected.guest && <EventExtras event={selected} onDone={close} />}
      {!selected.guest && (
        <label class="inline">
          Category
          <select
            data-testid="event-category"
            onChange={(e) => {
              const id = selected.id;
              const value = e.currentTarget.value;
              close();
              run(() =>
                api("POST", "/api/planner/events/category", { id, category: value || null }),
              );
            }}
          >
            <option value="" selected={!selected.manualCategory}>
              Automatic
            </option>
            {CATEGORIES.map((c) => (
              <option value={c} key={c} selected={selected.manualCategory === c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected.kind === "external" && !selected.levelFixed && (
        <form
          class="form"
          data-testid="external-priority"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget as HTMLFormElement);
            const [, calendarId, ...rest] = selected.id.split(":");
            const eventId = rest.join(":");
            const level = Number(f.get("level"));
            const series = f.get("series") === "on";
            close();
            run(() =>
              api(
                "POST",
                `/api/planner/external/${encodeURIComponent(calendarId ?? "")}/${encodeURIComponent(eventId)}/priority`,
                {
                  level,
                  series,
                },
              ),
            );
          }}
        >
          <label>
            Priority for booking links
            <select name="level">
              {[1, 2, 3, 4].map((l) => (
                <option value={l} key={l} selected={l === (selected.level ?? 1)}>
                  P{l}
                </option>
              ))}
            </select>
          </label>
          {selected.recurring && (
            <label class="inline">
              <input type="checkbox" name="series" />
              All events in the series
            </label>
          )}
          <button type="submit">Save priority</button>
          <p class="status wide">Only booking links read this. Tempoloom never moves this event.</p>
        </form>
      )}
      {selected.kind === "external" && selected.levelFixed && (
        <div class="form" data-testid="external-priority-fixed">
          <label>
            Priority for booking links
            <select disabled value="1">
              <option value="1">P1</option>
            </select>
          </label>
          <p class="status wide">{LEVEL_FIXED_NOTES[selected.levelFixed]}</p>
        </div>
      )}
      {selected.kind !== "external" && !selected.guest && (
        <div class="actions">
          <button
            type="button"
            onClick={() => {
              const id = selected.id;
              const locked = !selected.locked;
              close();
              run(() => api("POST", `/api/planner/events/${id}/lock`, { locked }));
            }}
          >
            {selected.locked ? "Unlock" : "Lock"}
          </button>
          {selected.kind === "task" && selected.sourceId && (
            <button
              type="button"
              onClick={() => {
                const id = selected.sourceId;
                close();
                run(() => api("POST", `/api/tasks/${id}/done`));
              }}
            >
              Mark task done
            </button>
          )}
          {selected.kind === "habit" && selected.sourceId && (
            <button
              type="button"
              onClick={() => {
                const id = selected.sourceId;
                const date = utcToLocal(z, selected.start).date;
                close();
                run(() => api("POST", `/api/habits/${id}/skip`, { date }));
              }}
            >
              Skip this day
            </button>
          )}
        </div>
      )}
      {selected.kind === "meeting" && <MeetingActions event={selected} run={run} close={close} />}
      {!selected.guest && (
        <EventActions key={selected.id} event={selected} zone={z} run={run} close={close} />
      )}
      <button type="button" class="ghost" onClick={() => (sidePanel.value = "assistant")}>
        Ask the assistant
      </button>
    </aside>
  );
}
