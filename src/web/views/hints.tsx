// Onboarding hints in the planner, shown until the user dismisses them. The
// advice to turn off other scheduling tools first (platform-current-version.md rule 17),
// the offer of a first mirroring policy (sync-calendar-mirroring.md rule 11), and
// the offer of assistant chat after sign-up (teams-settings-templates.md rule 15).
import { useEffect, useId, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { calendarList, displayName, failure, loadCalendars } from "../lib/calendars.tsx";
import { chatDraft, plannerReload, sidePanel } from "../lib/planner-signals.ts";
import { onLinkClick } from "../lib/router.ts";

export function PlannerHints() {
  const [hints, setHints] = useState<string[] | null>(null);
  const [chatOff, setChatOff] = useState(false);
  useEffect(() => {
    void api<{ hints: string[]; chatOff?: boolean }>("GET", "/api/hints").then((h) => {
      setHints(h.hints);
      setChatOff(h.chatOff ?? false);
    });
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
      {hints?.includes("assistant-chat") && (
        <ChatOffer off={chatOff} onDone={() => dismiss("assistant-chat")} />
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

/** The first question the offer puts in the chat's input box. */
const FIRST_QUESTION = "What is on my calendar this week?";

/**
 * Rule 15: offers assistant chat. While the team switch is off, the offer (shown
 * to admins only) turns chat on for the whole team first (rule 13).
 */
function ChatOffer({ off, onDone }: { off: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    try {
      if (off) await api("PATCH", "/api/team", { assistantChat: true });
    } catch (err) {
      setError(failure(err));
      return;
    }
    chatDraft.value = FIRST_QUESTION;
    sidePanel.value = "assistant";
    onDone();
  };
  return (
    <p class="hint" role="note" data-testid="hint-assistant-chat">
      {off
        ? "Assistant chat is off for your team. Turn it on to ask about your calendar and ask for changes in plain language. Every change waits for your approval in preview mode."
        : "Ask the assistant about your calendar, or ask for a change in plain language. Every change waits for your approval in preview mode."}{" "}
      <button type="button" onClick={() => void open()}>
        {off ? "Turn on assistant chat" : "Try the assistant"}
      </button>{" "}
      <button type="button" onClick={onDone}>
        Not now
      </button>
      {error && <span class="error"> {error}</span>}
    </p>
  );
}

/** One source and one destination; the other policy fields keep their defaults. */
function FirstMirror({ onDone, onDismiss }: { onDone: () => void; onDismiss: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    loadCalendars()
      .then(() => setLoaded(true))
      .catch((err) => setError(failure(err)));
  }, []);
  const calendars = calendarList.value.filter((c) => c.provider !== "ics");
  if (!loaded) return error ? <p class="hint error">{error}</p> : null;
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
          .then(() => {
            onDone();
            // The two calendars are now locked, and the planner shows the copies.
            plannerReload.value++;
            return loadCalendars();
          })
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
