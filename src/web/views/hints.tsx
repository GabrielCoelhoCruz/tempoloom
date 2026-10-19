// Onboarding hints in the planner, shown until the user dismisses them. The
// advice to turn off other scheduling tools first (platform-current-version.md rule 17),
// and the offer of a first mirroring policy (sync-calendar-mirroring.md rule 11).
import { useEffect, useId, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { type CalendarRow, displayName, failure } from "../lib/calendars.tsx";
import { onLinkClick } from "../lib/router.ts";

export function PlannerHints() {
  const [hints, setHints] = useState<string[] | null>(null);
  useEffect(() => {
    void api<{ hints: string[] }>("GET", "/api/hints").then((h) => setHints(h.hints));
  }, []);
  const dismiss = (hint: string) => {
    setHints((list) => (list ?? []).filter((h) => h !== hint));
    void api("POST", `/api/hints/${hint}/dismiss`);
  };
  return (
    <div data-testid="planner-hints" data-loaded={hints !== null}>
      {hints?.includes("other-tools") && (
        <p class="hint" role="note" data-testid="hint-other-tools">
          Before Tempoloom plans your week, turn off any other scheduling tool that writes to these
          calendars, so the two tools do not create competing events.{" "}
          <a href="/help/other-tools" onClick={onLinkClick}>
            Why
          </a>{" "}
          <button type="button" onClick={() => dismiss("other-tools")}>
            Got it
          </button>
        </p>
      )}
      {hints?.includes("first-mirror") && (
        <FirstMirror
          onDone={() => setHints((l) => (l ?? []).filter((h) => h !== "first-mirror"))}
          onDismiss={() => dismiss("first-mirror")}
        />
      )}
    </div>
  );
}

/** One source and one destination; the other policy fields keep their defaults. */
function FirstMirror({ onDone, onDismiss }: { onDone: () => void; onDismiss: () => void }) {
  const [calendars, setCalendars] = useState<CalendarRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    void api<{ calendars: CalendarRow[] }>("GET", "/api/calendars").then((r) =>
      setCalendars(r.calendars.filter((c) => c.provider !== "ics")),
    );
  }, []);
  if (!calendars) return null;
  return (
    <form
      class="hint"
      aria-label="Mirror a calendar"
      data-testid="hint-first-mirror"
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget as HTMLFormElement);
        void api("POST", "/api/mirrors", {
          sourceCalendarId: String(d.get("source")),
          destCalendarId: String(d.get("dest")),
        })
          .then(onDone)
          .catch((err) => setError(failure(err)));
      }}
    >
      Copy the events of one calendar to another as busy time, so people who look at the second
      calendar see when you are busy. <label for={`${id}-source`}>Copy events from</label>{" "}
      <select id={`${id}-source`} name="source">
        {calendars.map((c) => (
          <option value={c.id} key={c.id}>
            {displayName(c, calendars)}
          </option>
        ))}
      </select>{" "}
      <label for={`${id}-dest`}>To</label>{" "}
      <select id={`${id}-dest`} name="dest">
        {calendars.map((c, i) => (
          <option value={c.id} key={c.id} selected={i === 1}>
            {displayName(c, calendars)}
          </option>
        ))}
      </select>{" "}
      <button type="submit">Start mirroring</button>{" "}
      <button type="button" onClick={onDismiss}>
        Not now
      </button>
      {error && <span class="error"> {error}</span>}
    </form>
  );
}
