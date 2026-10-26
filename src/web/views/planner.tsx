import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CATEGORIES } from "../../scheduler/categories.ts";
import type { ReportEntry } from "../../scheduler/model.ts";
import type { AllDayBusy, CalendarRef, PlannerEvent } from "../../server/api/planner.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { calendarList, displayName, loadCalendars } from "../lib/calendars.tsx";
import { CATEGORY_LABELS } from "../lib/categories.ts";
import {
  clockText,
  dateText,
  displayWeekOf,
  formatWhen,
  sameWeekShown,
  userFormats,
} from "../lib/format.ts";
import { lazyComponent, settle, settled } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { useNewest } from "../lib/newest.ts";
import {
  blockPreview,
  conflictIds,
  extraZone,
  plannerContext,
  plannerReload,
  sidePanel,
  viewAs,
} from "../lib/planner-signals.ts";
import { overlay, withPreview } from "../lib/preview.ts";
import { me, planNow, zone } from "../lib/state.ts";
import { WeekView } from "./week.tsx";

// The Issues and Recommendations panel loads on demand, after the week view.
const IssuesPanel = lazyComponent(() => import("./issues-panel.tsx").then((m) => m.IssuesPanel));
// Parts that load after the planner (docs/performance.md): the now line, prompts and event notes.
const NowBar = lazyComponent<{ from: number; to: number }>(() =>
  import("./planner-now.tsx").then((m) => m.NowBar),
);
const TravelPrompt = lazyComponent(() => import("./planner-now.tsx").then((m) => m.TravelPrompt));
const EventExtras = lazyComponent<{ event: PlannerEvent; onDone: () => void }>(() =>
  import("./planner-now.tsx").then((m) => m.EventExtras),
);

const AWAY = "time away (all-day or out-of-office events) covers all its hours";
const REASONS: Record<string, string> = {
  "outside-window": "starts after the scheduling window",
  "no-hours": "its hours have no time in this period",
  "too-long-for-hours": "longer than any range of its hours",
  away: AWAY,
  // Reports stored before the rename still say "all-day-block".
  "all-day-block": AWAY,
  "reserved-word": "an event with a reserved word exists that day",
  "no-space-fixed": "no free time between your meetings",
  "no-space-priority": "higher-priority items use the free time",
  "after-due": "part of the work ends after the due date",
};

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

const PreviewPanel = lazyComponent<{ onApplied: () => void }>(() =>
  import("./preview.tsx").then((m) => m.PreviewPanel),
);
// PLN-3, PLN-6, PLN-20: the gear menu, "view as" and the calendars panel.
const AssistantPanel = lazyComponent(() => import("./assistant.tsx").then((m) => m.AssistantPanel));
const PlannerOptions = lazyComponent(() =>
  import("./planner-options.tsx").then((m) => m.PlannerOptions),
);
const TaskHereDialog = lazyComponent<{
  start: number;
  end: number;
  onClose: (created: boolean) => void;
}>(() => import("./task-here.tsx").then((m) => m.TaskHereDialog));
const PlannerHints = lazyComponent(() => import("./hints.tsx").then((m) => m.PlannerHints));
// Event actions, the running event's tasks and focus progress load on demand.
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
const CurrentTasks = lazyComponent(() =>
  import("./planner-extras.tsx").then((m) => m.CurrentTasks),
);
const LogWork = lazyComponent<{
  start: number;
  minutes?: number | undefined;
  onClose: (saved: boolean) => void;
}>(() => import("./planner-extras.tsx").then((m) => m.LogWork));
const FocusProgress = lazyComponent<{ week: string }>(() =>
  import("./planner-extras.tsx").then((m) => m.FocusProgress),
);

/**
 * PLN-3: the days the planner shows for a week that starts on `first`: 7 days,
 * 9 days, or Monday to Friday of that week (also when it starts on Sunday).
 */
function shownDays(first: string, mode: "all-days" | "weekdays" | "rolling-9-days"): string[] {
  if (mode === "weekdays") {
    const monday = addDays(first, (8 - weekdayOf(first)) % 7);
    return Array.from({ length: 5 }, (_, i) => addDays(monday, i));
  }
  return Array.from({ length: mode === "rolling-9-days" ? 9 : 7 }, (_, i) => addDays(first, i));
}

/** The first day of the display week that holds `t` (PRF-6: the user's week start). */
function weekOf(z: string, t: number): string {
  return displayWeekOf(utcToLocal(z, t).date);
}

export function Planner() {
  const z = zone();
  // ?week=YYYY-MM-DD opens that week, so a week can be linked; ?day= opens
  // the week of that day and marks the day (the weekly report's preview links).
  const [focusDay] = useState(() => {
    const q = new URLSearchParams(location.search).get("day");
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : null;
  });
  const [weekStart, setWeekStart] = useState(() => {
    const q = focusDay ?? new URLSearchParams(location.search).get("week");
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? displayWeekOf(q) : weekOf(z, Date.now());
  });
  const [events, setEvents] = useState<PlannerEvent[]>([]);
  const [report, setReport] = useState<ReportEntry[]>([]);
  const [allDay, setAllDay] = useState<AllDayBusy[]>([]);
  const [selected, setSelectedEvent] = useState<PlannerEvent | null>(null);
  // PLN-21: the event details are one mode of the side panel.
  const setSelected = (e: PlannerEvent | null) => {
    setSelectedEvent(e);
    if (e) sidePanel.value = "details";
  };
  const settings = me.value?.settings;
  const plannerDays = settings?.plannerDays ?? "all-days";
  // The week start can change with the next read of the account (PRF-6, planner edge case 4).
  const first = userFormats().weekStart;
  useEffect(() => setWeekStart((w) => sameWeekShown(w)), [first]);
  const hidden = useMemo(() => new Set(settings?.hiddenCalendars ?? []), [settings]);
  const others = viewAs.value === "others";
  // PLN-6: others see no event details and no conflict titles, so a switch
  // closes the open details and the conflicts panel.
  useEffect(() => {
    if (!others) return;
    setSelectedEvent(null);
    if (sidePanel.value === "details" || sidePanel.value === "conflicts") sidePanel.value = null;
  }, [others]);
  // PRG-20, PRG-21: the log work form, opened on a past time or from the toolbar.
  const [logAt, setLogAt] = useState<{ start: number; minutes?: number | undefined } | null>(null);
  // The drawer names calendars as the calendar list does; that list loads on the first open.
  const external = selected?.kind === "external";
  useEffect(() => {
    if (external && calendarList.value.length === 0) void loadCalendars().catch(() => {});
  }, [external]);
  const [busy, setBusy] = useState(false);
  // TSK-7: a range picked on free space, for a new locked task.
  const [here, setHere] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A planner link (?item=task:<id>, planning-event-content.md CNT-10) opens that item's event.
  const openItem = useRef(new URLSearchParams(location.search).get("item"));
  const days = useMemo(() => shownDays(weekStart, plannerDays), [weekStart, plannerDays]);
  // The loaded range: from the first to the end of the last day shown.
  const fromDay = days[0] ?? weekStart;
  const toDay = addDays(days.at(-1) ?? weekStart, 1);
  const selectedId = selected?.id;
  useEffect(() => {
    plannerContext.value = {
      from: fromDay,
      to: toDay,
      ...(selectedId ? { eventId: selectedId } : {}),
    };
  }, [fromDay, toDay, selectedId]);

  // Answers can arrive out of order (another week, a live update): only the
  // newest load may draw.
  const newest = useNewest();
  const load = useCallback(async () => {
    const isNewest = newest();
    const from = localToUtc(z, fromDay, 0);
    const to = localToUtc(z, toDay, 0);
    const [ev, rep] = await Promise.all([
      api<{ events: PlannerEvent[]; allDay: AllDayBusy[] }>(
        "GET",
        `/api/planner/events?from=${from}&to=${to}`,
      ),
      api<{ report: ReportEntry[] }>("GET", "/api/planner/report"),
    ]);
    if (!isNewest()) return;
    setEvents(ev.events);
    setAllDay(ev.allDay);
    setReport(rep.report);
    settle();
    // An ?item= link opens its event once the week that holds it is drawn.
    const want = openItem.current;
    const hit = want?.startsWith("event:") && ev.events.find((e) => e.id === want.slice(6));
    if (hit) {
      openItem.current = null;
      setSelected(hit);
    }
  }, [newest, z, fromDay, toDay]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  useLive(load);
  useEffect(() => {
    if (plannerReload.value > 0) void load();
  }, [plannerReload.value]);
  useEffect(() => {
    const ref = openItem.current;
    if (!ref) return;
    void api<{ event: { id: string; start: number } | null }>(
      "GET",
      `/api/now/item?ref=${encodeURIComponent(ref)}`,
    ).then(({ event }) => {
      if (!event) return;
      openItem.current = `event:${event.id}`;
      const week = weekOf(z, event.start);
      if (week === weekStart) void load();
      else setWeekStart(week);
    });
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await planNow();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const preview = blockPreview.value;
  const shown = useMemo(
    () => [
      ...events,
      ...(preview?.blocks.map(
        (b): PlannerEvent => ({
          ...b,
          title: preview.title,
          kind: "preview",
          busy: true,
          locked: false,
          movable: true,
          sourceId: null,
          manualCategory: null,
          description: "",
          calendarId: "",
          private: false,
        }),
      ) ?? []),
    ],
    [events, preview],
  );
  // PLN-20: hidden calendars stay connected but are not drawn. PLN-6: others
  // see busy time only, and no title of a private event.
  const visible = useMemo(
    () =>
      shown
        .filter((e) => !hidden.has(e.calendarId))
        .filter((e) => !others || e.busy)
        .map((e) =>
          others ? { ...e, movable: false, ...(e.private ? { title: "Busy" } : {}) } : e,
        ),
    [shown, hidden, others],
  );
  // PLN-5: days that a busy all-day event uses get the busy pattern.
  const busyDays = useMemo(() => {
    const out = new Map<string, string>();
    for (const d of days) {
      const s = localToUtc(z, d, 0);
      const e = localToUtc(z, addDays(d, 1), 0);
      const hit = allDay.filter((a) => !hidden.has(a.calendarId) && a.start < e && a.end > s);
      if (hit.length > 0) out.set(d, hit.map((a) => (others ? "Busy" : a.title)).join(", "));
    }
    return out;
  }, [days, z, allDay, hidden, others]);

  const onMove = (id: string, start: number) => {
    if (preview && id.startsWith("preview:")) {
      // NXT-50: the user changes a proposed block before applying it.
      blockPreview.value = {
        ...preview,
        blocks: preview.blocks.map((b) =>
          b.id === id ? { ...b, start, end: start + (b.end - b.start) } : b,
        ),
      };
      return;
    }
    // Optimistic: show the event at its new place at once.
    setEvents((list) =>
      list.map((e) =>
        e.id === id ? { ...e, start, end: start + (e.end - e.start), locked: true, busy: true } : e,
      ),
    );
    void run(() => api("POST", `/api/planner/events/${id}/move`, { start }));
  };

  return (
    <div class="planner" data-testid="planner">
      <div class="toolbar">
        <button
          type="button"
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          aria-label="Previous week"
        >
          ‹
        </button>
        <button type="button" onClick={() => setWeekStart(weekOf(z, Date.now()))}>
          Today
        </button>
        <button
          type="button"
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          aria-label="Next week"
        >
          ›
        </button>
        <span class="title" data-testid="week-label">
          Week of {dateText(weekStart)}
        </span>
        {error && <span class="error">{error}</span>}
        {settled.value && <PlannerOptions />}
        <span class="status">
          {busy ? "Planning…" : `${events.filter((e) => e.kind !== "external").length} planned`}
        </span>
        <button
          type="button"
          onClick={() =>
            setLogAt({ start: Math.floor((Date.now() - 3_600_000) / 900_000) * 900_000 })
          }
        >
          Log work
        </button>
        <button
          type="button"
          class="primary"
          disabled={busy}
          onClick={() => void run(async () => {})}
        >
          Plan now
        </button>
        <button
          type="button"
          aria-expanded={sidePanel.value === "assistant"}
          onClick={() => {
            sidePanel.value = sidePanel.value === "assistant" ? null : "assistant";
          }}
        >
          Assistant
        </button>
      </div>
      {sidePanel.value === "assistant" && <AssistantPanel />}
      {logAt !== null && (
        <LogWork
          key={`${logAt.start}:${logAt.minutes}`}
          start={logAt.start}
          minutes={logAt.minutes}
          onClose={(saved) => {
            setLogAt(null);
            // The new past event changes the plan: plan again, then draw the week.
            if (saved) void planNow().then(load);
          }}
        />
      )}
      <div class="now-bar" data-testid="now-bar">
        {settled.value && <NowBar from={localToUtc(z, fromDay, 0)} to={localToUtc(z, toDay, 0)} />}
      </div>
      {settled.value && (
        <>
          <TravelPrompt />
          <PlannerHints />
          <PreviewPanel onApplied={() => void load()} />
          {/* The planning week that holds most of the days shown (planning keeps its own week start). */}
          <FocusProgress week={addDays(weekStart, 3)} />
          <CurrentTasks />
        </>
      )}
      <WeekView
        days={days}
        zone={z}
        focusDay={focusDay}
        events={withPreview(visible, overlay.value)}
        now={Date.now()}
        onMove={onMove}
        onSelect={(id) => {
          if (!others) setSelected(events.find((e) => e.id === id) ?? null);
        }}
        busyDays={busyDays}
        onCreate={(start, end) => {
          if (start < Date.now()) return;
          const minutes = me.value?.settings.taskDefaults.minutes ?? 60;
          setHere({ start, end: end ?? start + minutes * 60_000 });
        }}
        flagged={conflictIds.value}
        extraZone={extraZone.value}
        onPickPast={(start, minutes) => {
          setSelected(null);
          setLogAt({ start, minutes });
        }}
      />
      {here && (
        <TaskHereDialog
          start={here.start}
          end={here.end}
          onClose={(created) => {
            setHere(null);
            if (created) void load();
          }}
        />
      )}
      {settled.value && <IssuesPanel />}
      {report.length > 0 && (
        <details class="issues" data-testid="issues">
          <summary>{report.length} items need attention</summary>
          <ul>
            {report.slice(0, 50).map((r) => (
              <li key={r.demandKey}>
                <strong>{r.itemKind}</strong> {r.demandKey.split(":").slice(2).join(" ")} —{" "}
                {r.status}: {REASONS[r.reason] ?? r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {selected && !others && sidePanel.value === "details" && (
        <aside class="drawer" data-testid="event-drawer">
          <h2>{selected.title}</h2>
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
          {!selected.guest && <EventExtras event={selected} onDone={() => setSelected(null)} />}
          {!selected.guest && (
            <label class="inline">
              Category
              <select
                data-testid="event-category"
                onChange={(e) => {
                  const id = selected.id;
                  const value = e.currentTarget.value;
                  setSelected(null);
                  void run(() =>
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
                setSelected(null);
                void run(() =>
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
              <p class="status wide">
                Only booking links read this. Tempoloom never moves this event.
              </p>
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
                  setSelected(null);
                  void run(() => api("POST", `/api/planner/events/${id}/lock`, { locked }));
                }}
              >
                {selected.locked ? "Unlock" : "Lock"}
              </button>
              {selected.kind === "task" && selected.sourceId && (
                <button
                  type="button"
                  onClick={() => {
                    const id = selected.sourceId;
                    setSelected(null);
                    void run(() => api("POST", `/api/tasks/${id}/done`));
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
                    setSelected(null);
                    void run(() => api("POST", `/api/habits/${id}/skip`, { date }));
                  }}
                >
                  Skip this day
                </button>
              )}
            </div>
          )}
          {selected.kind === "meeting" && (
            <MeetingActions
              event={selected}
              run={(fn) => void run(fn)}
              close={() => setSelected(null)}
            />
          )}
          {!selected.guest && (
            <EventActions
              key={selected.id}
              event={selected}
              zone={z}
              run={(fn) => void run(fn)}
              close={() => setSelected(null)}
            />
          )}
          <button type="button" onClick={() => (sidePanel.value = "assistant")}>
            Ask the assistant
          </button>
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              sidePanel.value = null;
            }}
          >
            Close
          </button>
        </aside>
      )}
    </div>
  );
}
