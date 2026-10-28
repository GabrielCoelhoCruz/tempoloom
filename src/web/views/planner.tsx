import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ReportEntry } from "../../scheduler/model.ts";
import type { AllDayBusy, PlannerEvent } from "../../server/api/planner.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { hasAssistantLink } from "../lib/assistant-link.ts";
import { dateText, displayWeekOf, sameWeekShown, userFormats } from "../lib/format.ts";
import { lazyComponent, settle, settled } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { narrow, oneDay, threeDays } from "../lib/media.ts";
import { useNewest } from "../lib/newest.ts";
import {
  blockPreview,
  conflictIds,
  drawerOpen,
  extraZone,
  plannerContext,
  plannerReload,
  sidePanel,
  viewAs,
} from "../lib/planner-signals.ts";
import { overlay, reviewable, withPreview } from "../lib/preview.ts";
import { me, planNow, zone } from "../lib/state.ts";
import { WeekView } from "./week.tsx";

// The Issues and Recommendations panel loads on demand, after the week view.
const IssuesPanel = lazyComponent(() => import("./issues-panel.tsx").then((m) => m.IssuesPanel));
// Parts that load after the planner (docs/performance.md): the now line, prompts and event notes.
const NowBar = lazyComponent<{ from: number; to: number; children?: ComponentChildren }>(() =>
  import("./planner-now.tsx").then((m) => m.NowBar),
);
const TravelPrompt = lazyComponent(() => import("./planner-now.tsx").then((m) => m.TravelPrompt));
const NowPanel = lazyComponent(() => import("./planner-now.tsx").then((m) => m.NowPanel));
const HoursReviewNote = lazyComponent(() =>
  import("./planner-now.tsx").then((m) => m.HoursReviewNote),
);
// The event details load on the first click on an event.
const EventDetails = lazyComponent<{
  event: PlannerEvent;
  zone: string;
  run: (fn: () => Promise<unknown>) => void;
  close: () => void;
}>(() => import("./event-details.tsx").then((m) => m.EventDetails));

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
// The running event's tasks, focus progress, the report and log work load on demand.
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
const Report = lazyComponent<{ report: ReportEntry[] }>(() =>
  import("./planner-extras.tsx").then((m) => m.Report),
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
  const [busy, setBusy] = useState(false);
  // TSK-7: a range picked on free space, for a new locked task.
  const [here, setHere] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A planner link (?item=task:<id>, planning-event-content.md CNT-10) opens that item's event.
  const openItem = useRef(new URLSearchParams(location.search).get("item"));
  // LAY-62, LAY-63: 3 days at 860 px and below, 1 day at 640 px and below; they
  // start today in the week of today, else on the first day of the week.
  const span = oneDay.value ? 1 : threeDays.value ? 3 : 0;
  const [dayStart, setDayStart] = useState<string | null>(null);
  const days = useMemo(() => {
    const week = shownDays(weekStart, plannerDays);
    if (!span) return week;
    const today = utcToLocal(z, Date.now()).date;
    const from =
      dayStart && displayWeekOf(dayStart) === weekStart
        ? dayStart
        : week.includes(today)
          ? today
          : weekStart;
    return Array.from({ length: span }, (_, i) => addDays(from, i));
  }, [weekStart, plannerDays, span, dayStart, z]);
  /** One step back or forward: a week, or the days shown. */
  const step = (dir: number) => {
    if (!span) return setWeekStart(addDays(weekStart, 7 * dir));
    const from = addDays(days[0] ?? weekStart, span * dir);
    setDayStart(from);
    setWeekStart(displayWeekOf(from));
  };
  const unit = span === 1 ? "day" : span ? "3 days" : "week";
  // The loaded range: from the first to the end of the last day shown.
  const fromDay = days[0] ?? weekStart;
  const toDay = addDays(days.at(-1) ?? weekStart, 1);
  const selectedId = selected?.id;
  // A digest link (?assistant=<conversation>) opens the chat with its staged fixes.
  useEffect(() => {
    if (hasAssistantLink()) void import("./assistant.tsx").then((m) => m.openFromLink());
    // Off the planner, no dates are shown: the chat's Recommendations waits for them.
    return () => {
      plannerContext.value = { from: "", to: "" };
    };
  }, []);
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

  const panel = sidePanel.value;
  // LAY-60: the drawer opens when a panel opens.
  useEffect(() => {
    if (panel) drawerOpen.value = true;
  }, [panel]);
  const openLog = (at: { start: number; minutes?: number | undefined }) => {
    setLogAt(at);
    drawerOpen.value = true;
  };
  // LAY-6: the notices render in one place: above the week at 1180 px and below,
  // else in the right column.
  const notices = settled.value && (
    <div class="notices">
      <TravelPrompt />
      <HoursReviewNote />
      <PlannerHints />
    </div>
  );
  const sideToggle = (
    <button
      type="button"
      class="icon ghost i-side"
      aria-label="Side panel"
      title="Side panel"
      aria-expanded={drawerOpen.value}
      onClick={() => (drawerOpen.value = !drawerOpen.value)}
    />
  );

  return (
    <div class="planner" data-testid="planner">
      <div class="planner-main">
        <div class="toolbar">
          <span class="week-nav">
            <button
              type="button"
              class="icon i-prev"
              onClick={() => step(-1)}
              aria-label={`Previous ${unit}`}
            />
            <button
              type="button"
              onClick={() => {
                setDayStart(null);
                setWeekStart(weekOf(z, Date.now()));
              }}
            >
              Today
            </button>
            <button
              type="button"
              class="icon i-next"
              onClick={() => step(1)}
              aria-label={`Next ${unit}`}
            />
          </span>
          <span class="title" data-testid="week-label">
            Week of {dateText(weekStart)}
          </span>
          {error && <span class="error">{error}</span>}
          <span class="status">
            {busy ? "Planning…" : `${events.filter((e) => e.kind !== "external").length} planned`}
          </span>
          {settled.value && <PreviewPanel onApplied={() => void load()} />}
          {settled.value && <PlannerOptions />}
          <button
            type="button"
            class="icon ghost i-log"
            aria-label="Log work"
            title="Log work"
            onClick={() =>
              openLog({ start: Math.floor((Date.now() - 3_600_000) / 900_000) * 900_000 })
            }
          />
          <button
            type="button"
            // CMP-12: while staged changes wait for review, that button is the primary one.
            class={reviewable.value ? undefined : "primary"}
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            Plan now
          </button>
          {narrow.value && sideToggle}
        </div>
        {narrow.value && notices}
        <WeekView
          days={days}
          zone={z}
          focusDay={focusDay}
          selectedId={panel === "details" && !others ? selectedId : undefined}
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
            openLog({ start, minutes });
          }}
        />
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: LAY-60, Escape closes the drawer when the focus is inside it */}
      <div
        class="side-column"
        data-open={drawerOpen.value}
        onKeyDown={(e) => {
          if (e.key === "Escape") drawerOpen.value = false;
        }}
      >
        <div class="now-bar" data-testid="now-bar">
          <span class="panel-switch">
            {(["tasks", "priorities", "assistant"] as const).map((p) => (
              <button
                type="button"
                key={p}
                aria-expanded={panel === p}
                onClick={() => (sidePanel.value = panel === p ? null : p)}
              >
                {p[0]?.toUpperCase() + p.slice(1)}
              </button>
            ))}
          </span>
          {settled.value && (
            <NowBar from={localToUtc(z, fromDay, 0)} to={localToUtc(z, toDay, 0)}>
              {narrow.value && (
                <button
                  type="button"
                  class="icon ghost i-hide"
                  aria-label="Hide panel"
                  title="Hide panel"
                  onClick={() => (drawerOpen.value = false)}
                />
              )}
            </NowBar>
          )}
        </div>
        {!narrow.value && notices}
        <div class="side-scroll">
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
          {selected && !others && panel === "details" && (
            <EventDetails
              event={selected}
              zone={z}
              run={(fn) => void run(fn)}
              close={() => setSelected(null)}
            />
          )}
          {settled.value && <NowPanel />}
          {panel === "assistant" && <AssistantPanel />}
          {settled.value && (
            <div class="overview">
              {/* The planning week that holds most of the days shown (planning keeps its own week start). */}
              <FocusProgress week={addDays(weekStart, 3)} />
              <CurrentTasks />
              <IssuesPanel />
              <Report report={report} />
            </div>
          )}
        </div>
      </div>
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
    </div>
  );
}
