import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { CATEGORIES } from "../../scheduler/categories.ts";
import type { ReportEntry } from "../../scheduler/model.ts";
import type { PlannerEvent } from "../../server/api/planner.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { CATEGORY_LABELS } from "../lib/categories.ts";
import { formatWhen } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { overlay, withPreview } from "../lib/preview.ts";
import { planNow, zone } from "../lib/state.ts";
import { WeekView } from "./week.tsx";

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

const PreviewPanel = lazyComponent<{ onApplied: () => void }>(() =>
  import("./preview.tsx").then((m) => m.PreviewPanel),
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
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const load = useCallback(async () => {
    const from = localToUtc(z, weekStart, 0);
    const to = localToUtc(z, addDays(weekStart, 7), 0);
    const [ev, rep] = await Promise.all([
      api<{ events: PlannerEvent[] }>("GET", `/api/planner/events?from=${from}&to=${to}`),
      api<{ report: ReportEntry[] }>("GET", "/api/planner/report"),
    ]);
    setEvents(ev.events);
    setReport(rep.report);
  }, [z, weekStart]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  useLive(load);

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

  const onMove = (id: string, start: number) => {
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
      <PreviewPanel onApplied={() => void load()} />
      <WeekView
        days={days}
        zone={z}
        events={withPreview(events, overlay.value)}
        now={Date.now()}
        onMove={onMove}
        onSelect={(id) => setSelected(events.find((e) => e.id === id) ?? null)}
      />
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
          {selected.kind === "external" && selected.levelEditable && (
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
          <button type="button" onClick={() => setSelected(null)}>
            Close
          </button>
        </aside>
      )}
    </div>
  );
}
