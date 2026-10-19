// The stop dialog of the task timer (docs/specs/planning-task-progress.md
// PRG-31, PRG-32): edit the minutes, keep going, discard, mark the task done,
// pick the calendar, and see the event it adds before applying it.
import "./parts.css";
import { useEffect, useState } from "preact/hooks";
import { utcToLocal } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { hhmm } from "../lib/format.ts";
import { planNow, zone } from "../lib/state.ts";

interface Timer {
  kind: "task" | "habit";
  itemId: string;
  title: string;
  startedAt: number;
  minutes: number;
  calendars: { id: string; name: string }[];
  calendarId: string | null;
}

export function TimerDialog({ onClose }: { onClose: () => void }) {
  const z = zone();
  const [timer, setTimer] = useState<Timer | null>(null);
  const [minutes, setMinutes] = useState(1);
  const [calendarId, setCalendarId] = useState("");
  const [markDone, setMarkDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ timer: Timer | null }>("GET", "/api/timer").then(({ timer: t }) => {
      if (!t) return onClose();
      setTimer(t);
      setMinutes(t.minutes);
      setCalendarId(t.calendarId ?? t.calendars[0]?.id ?? "");
    });
  }, []);
  if (!timer) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await planNow();
      onClose();
    } catch (err) {
      setError((err as { body?: { message?: string } }).body?.message ?? "That did not work.");
    }
  };
  const end = Math.floor(Date.now() / 60_000) * 60_000;
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const calendar = timer.calendars.find((c) => c.id === calendarId)?.name ?? "";
  return (
    <div class="dialog-backdrop">
      <div class="dialog form" role="dialog" aria-modal="true" aria-labelledby="timer-title">
        <h2 id="timer-title" class="wide">
          Stop timer
        </h2>
        <p class="wide">{timer.title}</p>
        <label>
          Minutes
          <input
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onInput={(e) => setMinutes(Number(e.currentTarget.value))}
          />
        </label>
        <label>
          Calendar
          <select value={calendarId} onChange={(e) => setCalendarId(e.currentTarget.value)}>
            {timer.calendars.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {timer.kind === "task" && (
          <label class="inline wide">
            <input
              type="checkbox"
              checked={markDone}
              onChange={(e) => setMarkDone(e.currentTarget.checked)}
            />
            Mark the task done
          </label>
        )}
        <p class="status wide" data-testid="timer-preview">
          {valid
            ? `Adds “${timer.title}”, ${minutes} min, ${hhmm(utcToLocal(z, end - minutes * 60_000).minuteOfDay)}–${hhmm(utcToLocal(z, end).minuteOfDay)} today, to ${calendar}.`
            : "Enter 1 to 1440 minutes."}
        </p>
        {error && (
          <p class="error wide" role="alert">
            {error}
          </p>
        )}
        <div class="actions wide">
          <button
            type="button"
            class="primary"
            disabled={!valid || !calendarId}
            onClick={() =>
              void act(() => api("POST", "/api/timer/log", { minutes, calendarId, markDone }))
            }
          >
            Log time
          </button>
          <button type="button" onClick={onClose}>
            Keep going
          </button>
          <button
            type="button"
            class="danger"
            onClick={() => void act(() => api("DELETE", "/api/timer"))}
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
