// The planner's now line and prompts, loaded after the planner itself:
// the next-up task and task lists (planning-next-up.md NXT-20, NXT-30 to
// NXT-33), work blocks on request (NXT-50), the running timer
// (planning-task-progress.md PRG-30), the current or next meeting with a join
// link (planning-planner.md PLN-7), conflicts between external events
// (events-external-priority.md rule 8) and travel prompts
// (timezones-home-and-travel.md rules 8-11).
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { PlannerEvent } from "../../server/api/planner.ts";
import { addDays, utcToLocal } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { formatWhen, hhmm } from "../lib/format.ts";
import { lazyComponent } from "../lib/lazy.ts";
import { useLive } from "../lib/live.ts";
import { Markdown } from "../lib/markdown.tsx";
import {
  blockPreview,
  conflictIds,
  extraZone,
  plannerReload,
  sidePanel,
  viewAs,
} from "../lib/planner-signals.ts";
import { LEVEL_NAMES, loadMe, me, planNow, zone } from "../lib/state.ts";
import "./parts.css";

const TimerDialog = lazyComponent<{ onClose: () => void }>(() =>
  import("./timer-dialog.tsx").then((m) => m.TimerDialog),
);
const PrioritiesPanel = lazyComponent(() =>
  import("./priorities.tsx").then((m) => m.PrioritiesPanel),
);
const HoursReview = lazyComponent<{ onClose: () => void }>(() =>
  import("./hours-review.tsx").then((m) => m.HoursReview),
);

interface TaskLite {
  id: string;
  title: string;
  level: number;
  dueAt: number | null;
  remainingMinutes: number;
  nextUp: boolean;
}
interface Now {
  nextUp: TaskLite | null;
  meeting: {
    title: string;
    start: number;
    end: number;
    current: boolean;
    joinUrl: string | null;
    busy: boolean;
    private: boolean;
  } | null;
  timer: { kind: string; itemId: string; title: string; startedAt: number } | null;
}
interface Conflict {
  ids: [string, string];
  titles: [string, string];
  overlap: { start: number; end: number };
  fix: { title: string; start: number; end: number } | null;
}

const reason = (err: unknown) =>
  (err as { body?: { message?: string } }).body?.message ?? "That did not work. Try again.";

/** A plain time range: "Tue 27 Oct, 11:00–12:00". */
function span(z: string, start: number, end: number) {
  return `${formatWhen(z, start)}–${hhmm(utcToLocal(z, end).minuteOfDay)}`;
}

function TaskRow({ t, children }: { t: TaskLite; children?: ComponentChildren }) {
  const z = zone();
  return (
    <div class="row" data-task-title={t.title}>
      <span>
        {t.title}{" "}
        <span class="meta">
          {LEVEL_NAMES[t.level]}
          {t.dueAt ? ` · due ${formatWhen(z, t.dueAt)}` : ""}
        </span>
      </span>
      <span class="actions">{children}</span>
    </div>
  );
}

function TasksPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{
    placement: string;
    suggestedNow: TaskLite[];
    atRisk: (TaskLite & { why: string })[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => setData(await api("GET", "/api/now/tasks")), []);
  useEffect(() => void load(), [load]);
  useLive(load);
  const blockTime = async (t: TaskLite) => {
    setMessage(null);
    try {
      const r = await api<{ title: string; blocks: { start: number; end: number }[] }>(
        "POST",
        `/api/tasks/${t.id}/blocks/preview`,
      );
      if (r.blocks.length === 0) return setMessage("No free time for this task in the window.");
      blockPreview.value = {
        taskId: t.id,
        title: r.title,
        blocks: r.blocks.map((b, i) => ({ id: `preview:${i}`, ...b })),
      };
      onClose();
    } catch (err) {
      setMessage(reason(err));
    }
  };
  const startTimer = async (t: TaskLite) => {
    setMessage(null);
    try {
      await api("POST", "/api/timer", { kind: "task", itemId: t.id });
      plannerReload.value++;
      onClose();
    } catch (err) {
      setMessage(reason(err));
    }
  };
  // NXT-6: the planner tasks panel adds a task to the next-up queue.
  const addToQueue = async (t: TaskLite) => {
    setMessage(null);
    try {
      await api("POST", `/api/tasks/${t.id}/queue`, {});
      await planNow();
      plannerReload.value++;
      await load();
    } catch (err) {
      setMessage(reason(err));
    }
  };
  if (!data) return null;
  return (
    <div class="popover" data-testid="tasks-panel">
      {message && <p class="error">{message}</p>}
      <h3>Suggested now</h3>
      <div class="list" data-testid="suggested-now">
        {data.suggestedNow.map((t) => (
          <TaskRow t={t} key={t.id}>
            {data.placement === "suggestions" && (
              <button type="button" onClick={() => void blockTime(t)}>
                Block time
              </button>
            )}
            {!t.nextUp && (
              <button type="button" aria-label="Add to next up" onClick={() => void addToQueue(t)}>
                ↑
              </button>
            )}
            <button type="button" onClick={() => void startTimer(t)}>
              Start timer
            </button>
          </TaskRow>
        ))}
        {data.suggestedNow.length === 0 && <p class="status">No task to work on now.</p>}
      </div>
      <h3>At risk</h3>
      <div class="list" data-testid="at-risk">
        {data.atRisk.map((t) => (
          <TaskRow t={t} key={t.id}>
            <span class="badge risk">{t.why}</span>
          </TaskRow>
        ))}
        {data.atRisk.length === 0 && <p class="status">No task is at risk.</p>}
      </div>
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return (
    <span class="meta">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

export function NowBar({ from, to }: { from: number; to: number }) {
  const z = zone();
  const [now, setNow] = useState<Now | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  // PLN-21: one panel at a time; opening one closes the event details.
  const open = sidePanel.value;
  const setOpen = (v: typeof open) => (sidePanel.value = v);
  const [stopping, setStopping] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [n, c] = await Promise.all([
      api<Now>("GET", "/api/now"),
      api<{ conflicts: Conflict[] }>("GET", `/api/now/conflicts?from=${from}&to=${to}`),
    ]);
    setNow(n);
    setConflicts(c.conflicts);
    conflictIds.value = new Set(c.conflicts.flatMap((x) => x.ids));
  }, [from, to]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (plannerReload.value > 0) void load();
  }, [plannerReload.value, load]);
  useLive(load);

  const preview = blockPreview.value;
  const apply = async () => {
    if (!preview) return;
    setError(null);
    try {
      await api("POST", `/api/tasks/${preview.taskId}/blocks`, {
        blocks: preview.blocks.map(({ start, end }) => ({ start, end })),
      });
      blockPreview.value = null;
      await planNow();
      plannerReload.value++;
    } catch (err) {
      setError(reason(err));
    }
  };

  // HRS-15: a new user reviews the hours once.
  const review = me.value?.settings.hoursReviewed === false && (
    <span class="review" data-testid="hours-review-banner">
      New here? Check your hours.
      <button type="button" onClick={() => setReviewing(true)}>
        Review hours
      </button>
      <button
        type="button"
        onClick={() =>
          void api("PATCH", "/api/settings", { hoursReviewed: true }).then(() => loadMe())
        }
      >
        Looks right
      </button>
      {reviewing && <HoursReview onClose={() => setReviewing(false)} />}
    </span>
  );
  if (!now) return review || null;
  // PLN-6: as others see it, a free meeting looks open and a private one is only busy.
  const others = viewAs.value === "others";
  const m = others && !now.meeting?.busy ? null : now.meeting;
  const masked = others && m?.private;
  return (
    <>
      {review}
      <span data-testid="next-up">
        Next up: <strong>{now.nextUp?.title ?? "nothing"}</strong>
      </span>
      <button
        type="button"
        aria-expanded={open === "tasks"}
        onClick={() => setOpen(open === "tasks" ? null : "tasks")}
      >
        Tasks
      </button>
      <button
        type="button"
        aria-expanded={open === "priorities"}
        onClick={() => setOpen(open === "priorities" ? null : "priorities")}
      >
        Priorities
      </button>
      {now.timer && (
        <span class="timer-bar" data-testid="timer-bar">
          ⏱ {now.timer.title} <Elapsed since={now.timer.startedAt} />
          <button type="button" onClick={() => setStopping(true)}>
            Stop
          </button>
        </span>
      )}
      {preview && (
        <span class="block-preview" data-testid="block-preview">
          Preview: {preview.blocks.length} work blocks for {preview.title}
          <button type="button" class="primary" onClick={() => void apply()}>
            Apply
          </button>
          <button type="button" onClick={() => (blockPreview.value = null)}>
            Discard
          </button>
        </span>
      )}
      {error && <span class="error">{error}</span>}
      <span class="spacer" />
      {m && (
        <span data-testid="next-meeting">
          {m.current ? "Now" : "Next"}: <strong>{masked ? "Busy" : m.title}</strong>{" "}
          <span class="meta">{span(z, m.start, m.end)}</span>
          {m.joinUrl && !masked && (
            <a class="button" href={m.joinUrl} target="_blank" rel="noopener noreferrer">
              Join
            </a>
          )}
        </span>
      )}
      {conflicts.length > 0 && !others && (
        <button
          type="button"
          class="danger"
          aria-expanded={open === "conflicts"}
          onClick={() => setOpen(open === "conflicts" ? null : "conflicts")}
        >
          {conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}
        </button>
      )}
      {open === "tasks" && <TasksPanel onClose={() => setOpen(null)} />}
      {open === "priorities" && <PrioritiesPanel />}
      {open === "conflicts" && !others && (
        <div class="popover" data-testid="conflicts">
          {conflicts.map((c) => (
            <p key={c.ids.join()}>
              {c.titles[0]} and {c.titles[1]} overlap {span(z, c.overlap.start, c.overlap.end)}.{" "}
              {c.fix
                ? `Suggested fix: move ${c.fix.title} to ${span(z, c.fix.start, c.fix.end)}.`
                : "No free time to move either one this week."}{" "}
              Tempoloom moves neither event.
            </p>
          ))}
        </div>
      )}
      {stopping && (
        <TimerDialog
          onClose={() => {
            setStopping(false);
            plannerReload.value++;
          }}
        />
      )}
    </>
  );
}

/** The parts of the planner's event details that load later: notes, suggestions, the timer. */
export function EventExtras({ event, onDone }: { event: PlannerEvent; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const kind = event.kind;
  const timer = (kind === "task" || kind === "habit") && event.sourceId;
  return (
    <>
      {event.description && <Markdown text={event.description} />}
      {kind === "focus" && <FocusSuggestions eventId={event.id} />}
      {timer && (
        <div class="actions">
          <button
            type="button"
            onClick={() =>
              void api("POST", "/api/timer", { kind, itemId: event.sourceId })
                .then(() => {
                  plannerReload.value++;
                  onDone();
                })
                .catch((err) => setError(reason(err)))
            }
          >
            Start timer
          </button>
          {event.end > Date.now() && (
            <button
              type="button"
              title="Start this event now (it counts as started)"
              onClick={() =>
                void api("POST", `/api/planner/events/${event.id}/start`)
                  .then(() => planNow())
                  .then(() => {
                    plannerReload.value++;
                    onDone();
                  })
                  .catch((err) => setError(reason(err)))
              }
            >
              Start now
            </button>
          )}
          {kind === "task" &&
            event.start <= Date.now() &&
            event.end > Date.now() &&
            (
              [
                ["stop", "End now", "Stop: this chunk ends now, and the rest is placed later"],
                ["restart", "Restart", "Restart: this chunk starts again now, with its length"],
              ] as const
            ).map(([action, label, title]) => (
              <button
                key={action}
                type="button"
                title={title}
                onClick={() =>
                  void api("POST", `/api/tasks/${event.sourceId}/${action}`)
                    .then(() => planNow())
                    .then(() => {
                      plannerReload.value++;
                      onDone();
                    })
                    .catch((err) => setError(reason(err)))
                }
              >
                {label}
              </button>
            ))}
        </div>
      )}
      {error && <p class="error">{error}</p>}
    </>
  );
}

/** Suggested tasks inside a focus time block (platform-current-version.md rule 9). */
export function FocusSuggestions({ eventId }: { eventId: string }) {
  const [tasks, setTasks] = useState<TaskLite[] | null>(null);
  useEffect(() => {
    void api<{ tasks: TaskLite[] }>("GET", `/api/now/focus/${eventId}`).then((r) =>
      setTasks(r.tasks),
    );
  }, [eventId]);
  if (!tasks) return null;
  return (
    <div data-testid="focus-suggestions">
      <h3>Suggested tasks</h3>
      <div class="list">
        {tasks.map((t) => (
          <TaskRow t={t} key={t.id} />
        ))}
        {tasks.length === 0 && <p class="status">No open task fits this block.</p>}
      </div>
    </div>
  );
}

interface Travel {
  home: string;
  active: { id: string; tz: string; end_date: string } | null;
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Rules 8-11: the browser reports another zone than the one Tempoloom plans in. */
export function TravelPrompt() {
  const [travel, setTravel] = useState<Travel | null>(null);
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => sessionStorage.getItem("tempoloom.travelPrompt"));
  const load = useCallback(async () => setTravel(await api<Travel>("GET", "/api/travel")), []);
  useEffect(() => void load(), [load]);
  useLive(load);
  useEffect(() => {
    if (plannerReload.value > 0) void load();
  }, [plannerReload.value, load]);
  const browser = browserZone();
  const home = me.value?.user.time_zone ?? travel?.home ?? browser;
  const active = travel?.active ?? null;
  const planning = active?.tz ?? home;
  // Rule 10: the second column shows the travel zone, or the browser's when it differs.
  const extra = active && active.tz !== home ? active.tz : browser !== home ? browser : null;
  useEffect(() => {
    extraZone.value = travel ? extra : null;
    return () => {
      extraZone.value = null;
    };
  }, [extra, travel]);
  if (!travel || browser === planning || hidden === `${browser}>${planning}`) return null;

  const done = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      await planNow();
      plannerReload.value++;
    } catch (err) {
      setError(reason(err));
    }
  };
  const dismiss = () => {
    sessionStorage.setItem("tempoloom.travelPrompt", `${browser}>${planning}`);
    setHidden(`${browser}>${planning}`);
  };
  if (active && browser === home)
    return (
      <div class="banner" data-testid="travel-prompt">
        <span>
          Back home? Tempoloom still plans in {active.tz} until {active.end_date}.
        </span>
        <button
          type="button"
          onClick={() => void done(() => api("POST", `/api/travel/${active.id}/end`))}
        >
          End trip
        </button>
        <button type="button" onClick={dismiss}>
          Not now
        </button>
        {error && <span class="error">{error}</span>}
      </div>
    );
  const today = utcToLocal(browser, Date.now()).date;
  const end = until || addDays(today, 6);
  return (
    <div class="banner" data-testid="travel-prompt">
      <span>
        Your browser is in {browser}, but Tempoloom plans in {planning}. Are you travelling?
        {browser === "UTC" && home !== "UTC" && (
          <>
            {" "}
            An extension or a privacy setting can make a browser report UTC. If you are not in UTC,
            keep {home} and dismiss this.
          </>
        )}
      </span>
      <label class="inline">
        Until
        <input
          type="date"
          value={end}
          min={today}
          onInput={(e) => setUntil(e.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        onClick={() =>
          void done(() =>
            api("POST", "/api/travel", { tz: browser, startDate: today, endDate: end }),
          )
        }
      >
        Add travel time zone
      </button>
      <button type="button" onClick={dismiss}>
        Not now
      </button>
      {error && <span class="error">{error}</span>}
    </div>
  );
}
