import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CATEGORIES } from "../../scheduler/categories.ts";
import type { ReportEntry } from "../../scheduler/model.ts";
import type { PlannerEvent } from "../../server/api/planner.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { CATEGORY_LABELS } from "../lib/categories.ts";
import { formatWhen } from "../lib/format.ts";
import { lazyComponent, settle, settled } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { blockPreview, conflictIds, extraZone, plannerReload } from "../lib/planner-signals.ts";
import { overlay, withPreview } from "../lib/preview.ts";
import { planNow, zone } from "../lib/state.ts";
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

const REASONS: Record<string, string> = {
  "outside-window": "starts after the scheduling window",
  "no-hours": "its hours have no time in this period",
  "too-long-for-hours": "longer than any range of its hours",
  "all-day-block": "all-day events block every day",
  "reserved-word": "an event with a reserved word exists that day",
  "no-space-fixed": "no free time between your meetings",
  "no-space-priority": "higher-priority items use the free time",
  "after-due": "part of the work ends after the due date",
};

/** One note per reason the level of an external event stays P1. */
const LEVEL_FIXED_NOTES: Record<NonNullable<PlannerEvent["levelFixed"]>, string> = {
  "booking-link": "Meetings booked through a booking link stay P1: they are fixed.",
  "mirror-copy": "Mirrored copies stay P1: they follow their source event.",
  "other-calendar":
    "Events from other calendars stay P1: only events on your main calendar can change.",
};

const PreviewPanel = lazyComponent<{ onApplied: () => void }>(() =>
  import("./preview.tsx").then((m) => m.PreviewPanel),
);
const PlannerHints = lazyComponent(() => import("./hints.tsx").then((m) => m.PlannerHints));
// Event actions, the running event's tasks and focus progress load on demand.
const EventActions = lazyComponent<{
  event: PlannerEvent;
  zone: string;
  run: (fn: () => Promise<unknown>) => void;
  close: () => void;
}>(() => import("./planner-extras.tsx").then((m) => m.EventActions));
const CurrentTasks = lazyComponent(() =>
  import("./planner-extras.tsx").then((m) => m.CurrentTasks),
);
const FocusProgress = lazyComponent<{ week: string }>(() =>
  import("./planner-extras.tsx").then((m) => m.FocusProgress),
);

function mondayOf(z: string, t: number): string {
  const d = utcToLocal(z, t).date;
  return addDays(d, 1 - weekdayOf(d));
}

export function Planner() {
  const z = zone();
  // ?week=YYYY-MM-DD opens that week, so a week can be linked.
  const [weekStart, setWeekStart] = useState(() => {
    const q = new URLSearchParams(location.search).get("week");
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q)
      ? addDays(q, 1 - weekdayOf(q))
      : mondayOf(z, Date.now());
  });
  const [events, setEvents] = useState<PlannerEvent[]>([]);
  const [report, setReport] = useState<ReportEntry[]>([]);
  const [selected, setSelected] = useState<PlannerEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A planner link (?item=task:<id>, planning-event-content.md CNT-10) opens that item's event.
  const openItem = useRef(new URLSearchParams(location.search).get("item"));
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  // Answers can arrive out of order (another week, a live update): only the
  // newest load may draw.
  const loads = useRef(0);
  const load = useCallback(async () => {
    const n = ++loads.current;
    const from = localToUtc(z, weekStart, 0);
    const to = localToUtc(z, addDays(weekStart, 7), 0);
    const [ev, rep] = await Promise.all([
      api<{ events: PlannerEvent[] }>("GET", `/api/planner/events?from=${from}&to=${to}`),
      api<{ report: ReportEntry[] }>("GET", "/api/planner/report"),
    ]);
    if (n !== loads.current) return;
    setEvents(ev.events);
    setReport(rep.report);
    settle();
    // An ?item= link opens its event once the week that holds it is drawn.
    const want = openItem.current;
    const hit = want?.startsWith("event:") && ev.events.find((e) => e.id === want.slice(6));
    if (hit) {
      openItem.current = null;
      setSelected(hit);
    }
  }, [z, weekStart]);

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
      const week = mondayOf(z, event.start);
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
        }),
      ) ?? []),
    ],
    [events, preview],
  );

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
        <button type="button" onClick={() => setWeekStart(mondayOf(z, Date.now()))}>
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
          Week of {weekStart}
        </span>
        {error && <span class="error">{error}</span>}
        <span class="status">
          {busy ? "Planning…" : `${events.filter((e) => e.kind !== "external").length} planned`}
        </span>
        <button
          type="button"
          class="primary"
          disabled={busy}
          onClick={() => void run(async () => {})}
        >
          Plan now
        </button>
      </div>
      <div class="now-bar" data-testid="now-bar">
        {settled.value && (
          <NowBar from={localToUtc(z, weekStart, 0)} to={localToUtc(z, addDays(weekStart, 7), 0)} />
        )}
      </div>
      {settled.value && (
        <>
          <TravelPrompt />
          <PlannerHints />
          <PreviewPanel onApplied={() => void load()} />
          <FocusProgress week={weekStart} />
          <CurrentTasks />
        </>
      )}
      <WeekView
        days={days}
        zone={z}
        events={withPreview(shown, overlay.value)}
        now={Date.now()}
        onMove={onMove}
        onSelect={(id) => setSelected(events.find((e) => e.id === id) ?? null)}
        flagged={conflictIds.value}
        extraZone={extraZone.value}
      />
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
      {selected && (
        <aside class="drawer" data-testid="event-drawer">
          <h2>{selected.title}</h2>
          <div class="status">
            {formatWhen(z, selected.start)} – {formatWhen(z, selected.end)}
          </div>
          <div class="status">
            {selected.kind} · {selected.busy ? "busy" : "free"}
            {selected.locked && selected.kind !== "external" ? " · locked" : ""}
            {selected.category ? ` · ${CATEGORY_LABELS[selected.category]}` : ""}
          </div>
          {selected.calendar && (
            <div class="status" data-testid="event-source">
              Calendar: {selected.calendar}
            </div>
          )}
          {selected.copies && selected.copies.length > 0 && (
            <div class="status" data-testid="event-copies">
              Copied to: {selected.copies.join(", ")}
            </div>
          )}
          <EventExtras event={selected} onDone={() => setSelected(null)} />
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
              <p class="status wide">
                {LEVEL_FIXED_NOTES[selected.levelFixed]}
              </p>
            </div>
          )}
          {selected.kind !== "external" && (
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
              {selected.kind === "meeting" && selected.sourceId && (
                <button
                  type="button"
                  onClick={() => {
                    const id = selected.sourceId;
                    const eventId = selected.id;
                    setSelected(null);
                    void run(() => api("POST", `/api/meetings/${id}/skip`, { eventId }));
                  }}
                >
                  Skip this time
                </button>
              )}
            </div>
          )}
          <EventActions
            key={selected.id}
            event={selected}
            zone={z}
            run={(fn) => void run(fn)}
            close={() => setSelected(null)}
          />
          <button type="button" onClick={() => setSelected(null)}>
            Close
          </button>
        </aside>
      )}
    </div>
  );
}
