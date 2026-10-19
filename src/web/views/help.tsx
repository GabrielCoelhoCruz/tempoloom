// Help (docs/specs/support-troubleshooting.md): the troubleshooting index, one
// page per problem with the fix, and the event lookup with Tempoloom's change log.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";
import { navigate, onLinkClick, path } from "../lib/router.ts";

function A({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} onClick={onLinkClick}>
      {children}
    </a>
  );
}

interface HelpPageContent {
  title: string;
  body: () => ComponentChildren;
}

const LOOKUP = "/help/lookup";

const PAGES: Record<string, HelpPageContent> = {
  "meeting-not-placed": {
    title: "A flexible meeting is not placed",
    body: () => (
      <>
        <p>
          Tempoloom places a flexible meeting only inside the meeting hours of every required guest
          who uses this server, and only where all of them are free.
        </p>
        <ul>
          <li>Open the planner: “items need attention” names the meeting and the reason.</li>
          <li>Make a guest optional, or widen the meeting hours, to give it more room.</li>
        </ul>
      </>
    ),
  },
  "booked-guests": {
    title: "Guests do not see a booked meeting",
    body: () => (
      <>
        <p>
          Google Calendar can keep invitations from unknown senders off a guest's calendar until the
          guest accepts by email, and the email can land in spam. Tempoloom does not answer the
          invitation for the guest.
        </p>
        <ul>
          <li>
            In Google Calendar settings, set the automatic adding of invitations to “from everyone”,
            and ask your guests to do the same.
          </li>
          <li>When Google shows an unknown-sender notice, mark the sender as known.</li>
          <li>The booking reminder email reaches guests even when the invitation is hidden.</li>
        </ul>
      </>
    ),
  },
  "copies-missing": {
    title: "Copies are missing",
    body: () => (
      <>
        <p>When an event on a source calendar has no copy, do these steps in order:</p>
        <ol>
          <li>
            Turn the mirroring off in <A href="/settings">Calendar mirroring settings</A>, wait a
            few minutes, and turn it on again. Then Tempoloom reads the source calendar again and
            writes each copy that is missing.
          </li>
          <li>
            If a copy is still missing, <A href={LOOKUP}>look the event up</A> and send its event
            link to the person who runs this server.
          </li>
        </ol>
        <p class="warning">
          Do not turn mirroring off and on many times in a short time: your calendar provider can
          slow down your account when it gets many changes quickly.
        </p>
      </>
    ),
  },
  "copies-twice": {
    title: "Copies appear twice",
    body: () => (
      <>
        <p>Two mirrorings that copy the same source calendar to one calendar make two copies.</p>
        <ul>
          <li>
            Open <A href="/settings">Calendar mirroring settings</A> and delete one of them.
          </li>
          <li>
            Another tool that also copies events between these calendars makes copies too: turn it
            off.
          </li>
        </ul>
      </>
    ),
  },
  "copies-details": {
    title: "Copies miss details",
    body: () => (
      <p>
        A copy shows only what its mirroring allows: a label, “Busy”, or the title and description.
        To copy the details, change “Copies show” of the mirroring in{" "}
        <A href="/settings">Calendar mirroring settings</A>. Guests, alerts and attachments are
        never copied.
      </p>
    ),
  },
  "focus-not-placed": {
    title: "Focus time is not placed",
    body: () => (
      <p>
        Focus time fills its weekly goal inside your work hours, between the daily minimum and
        maximum, in blocks of the shortest and longest length you set. Meetings and items with a
        higher priority come first. Lower the goal or the shortest block to give it more room.
      </p>
    ),
  },
  "task-not-placed": {
    title: "A task is not placed",
    body: () => (
      <p>
        A task is placed between its start date and due date, inside its hours and the scheduling
        window. The task list and the planner's “items need attention” give the reason. A chunk
        longer than any free range of its hours cannot be placed.
      </p>
    ),
  },
  "buffer-missing": {
    title: "A buffer does not appear",
    body: () => (
      <p>
        A buffer follows only the events that match its filter, and it needs free time next to the
        event. When an item with a higher priority holds that time, the buffer is removed or kept as
        a conflict, as you chose.
      </p>
    ),
  },
  colors: {
    title: "Colors do not show",
    body: () => (
      <p>
        Tempoloom colors the events it manages by category. To color your other events too, choose
        “All events on my calendars” in <A href="/settings">Settings</A>. Outlook calendars may not
        show these colors.
      </p>
    ),
  },
  "item-not-placed": {
    title: "An item does not get placed",
    body: () => (
      <p>
        Open the planner: “items need attention” lists each item that has no place and the reason,
        for example no free time in its hours or a due date that is too close.
      </p>
    ),
  },
  "wrong-hours": {
    title: "Events are placed at the wrong hours",
    body: () => (
      <p>
        Check the time zone and the hours in <A href="/settings">Settings</A>. Each task, habit and
        focus goal uses one set of hours: work, personal, meeting or your own.
      </p>
    ),
  },
  "apple-alerts": {
    title: "Alerts for copies on Apple devices",
    body: () => (
      <>
        <p>
          Copies never alert: Tempoloom writes them without alerts. Apple Calendar can still alert,
          because its default alert time applies to events without alerts. On each device:
        </p>
        <ol>
          <li>In the device's calendar settings, set the default alert time for events to None.</li>
          <li>Turn off the calendar account on the device and delete its local data.</li>
          <li>Turn the calendar account on again and wait for the full download.</li>
        </ol>
      </>
    ),
  },
  "events-come-back": {
    title: "Events come back after you delete them",
    body: () => (
      <>
        <p>
          Tempoloom treats a deleted event as a skip for that time, and places the item at another
          time. To stop an item for good:
        </p>
        <ul>
          <li>
            Habit: delete the habit, or turn the habit off, on the <A href="/habits">Habits</A>{" "}
            page.
          </li>
          <li>
            Focus time: turn focus time off by deleting its goal in <A href="/settings">Settings</A>
            .
          </li>
          <li>
            Task: delete it (Tempoloom removes all its events, past ones too), or mark it done (past
            events stay), on the <A href="/tasks">Tasks</A> page.
          </li>
          <li>
            Mirrored copy: decline or delete the source event, or add #tl_nosync to its title or
            description.
          </li>
        </ul>
      </>
    ),
  },
  "other-tools": {
    title: "Turn off other scheduling tools",
    body: () => (
      <p>
        Before Tempoloom plans your week, turn off any other scheduling tool that creates events on
        the same calendars, such as another planner or a focus time app. Two tools that plan the
        same calendar create competing events and move each other's events.
      </p>
    ),
  },
};

const GROUPS: { name: string; entries: [string, string][] }[] = [
  { name: "Flexible meetings", entries: [["meeting-not-placed", ""]] },
  { name: "Booking links", entries: [["booked-guests", ""]] },
  {
    name: "Calendar mirroring",
    entries: [
      ["copies-missing", ""],
      ["copies-twice", ""],
      ["copies-details", ""],
      ["lookup", "Repair one event"],
    ],
  },
  { name: "Focus time", entries: [["focus-not-placed", ""]] },
  { name: "Tasks", entries: [["task-not-placed", ""]] },
  { name: "Buffers", entries: [["buffer-missing", ""]] },
  { name: "Settings and colors", entries: [["colors", ""]] },
  {
    name: "General",
    entries: [
      ["item-not-placed", ""],
      ["wrong-hours", ""],
      ["apple-alerts", ""],
      ["events-come-back", ""],
      ["other-tools", ""],
      ["lookup", "Look up one event"],
    ],
  },
];

function Index() {
  const [support, setSupport] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void api<{ supportUrl: string | null }>("GET", "/api/help").then((h) =>
      setSupport(h.supportUrl),
    );
  }, []);
  return (
    <div class="page help" data-testid="help-index">
      <h1>Help</h1>
      {GROUPS.map((g) => (
        <section key={g.name}>
          <h2>{g.name}</h2>
          <ul>
            {g.entries.map(([slug, label]) => (
              <li key={slug + label}>
                <A href={`/help/${slug}`}>{label || PAGES[slug]?.title}</A>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section>
        <h2>Contact support</h2>
        {support ? (
          <p>
            <a href={support} target="_blank" rel="noopener noreferrer">
              Report a problem
            </a>
            . Add the event link of the event in question.
          </p>
        ) : (
          <p>Ask the person who runs this server. Add the event link of the event in question.</p>
        )}
      </section>
    </div>
  );
}

interface Lookup {
  event: { title: string; when: string };
  calendar: { name: string; account: string; lastRead: string | null; lastError: string | null };
  item: { kind: string; title: string; locked: boolean } | null;
  copy: { policy: string; source: { title: string; calendar: string } | null } | null;
  policies: { name: string; decision: "copied" | "skipped"; reason: string }[];
  changes: { at: string; action: string; reason: string; range: string; actor: string }[];
}

const ERRORS: Record<string, string> = {
  unreadable: "Tempoloom cannot read this link. Paste the event id instead.",
  unknown_calendar:
    "Tempoloom cannot see that calendar. Add its account on the Account page, or check the link.",
  not_found:
    "No event with this link or id is on your calendars. If you deleted it, restore it from your calendar's trash first, then copy its link again.",
};

function LookupView() {
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [result, setResult] = useState<Lookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (value: string) => {
    setError(null);
    setResult(null);
    if (!value.trim()) return;
    try {
      setResult(await api<Lookup>("GET", `/api/help/lookup?q=${encodeURIComponent(value)}`));
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string })?.error : undefined;
      setError(ERRORS[code ?? ""] ?? "The lookup failed. Try again.");
    }
  };
  // A link to this page with ?q= shows that event, also after a reload.
  useEffect(() => void run(q), []);
  return (
    <div class="page help" data-testid="lookup-page">
      <p>
        <A href="/help">‹ All help topics</A>
      </p>
      <h1>Look up one event</h1>
      <p>
        Paste the link of the event in your calendar app, or its event id. On a CalDAV server the
        link is the event's address, ending in .ics. On Google Calendar, open the event and copy the
        address from the browser. If you deleted the event, restore it from your calendar's trash
        first to get its link.
      </p>
      <form
        class="form"
        data-testid="lookup-form"
        onSubmit={(e) => {
          e.preventDefault();
          history.replaceState(null, "", `/help/lookup?q=${encodeURIComponent(q)}`);
          void run(q);
        }}
      >
        <label class="wide">
          Event link or id
          <input value={q} onInput={(e) => setQ(e.currentTarget.value)} required />
        </label>
        <button type="submit" class="primary">
          Look up
        </button>
      </form>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div class="list" data-testid="lookup-result">
          <h2>{result.event.title || "(no title)"}</h2>
          <p class="status">{result.event.when}</p>
          <p>
            Calendar: {result.calendar.name} ({result.calendar.account}) · Last read:{" "}
            {result.calendar.lastRead ?? "never"} · Last error:{" "}
            {result.calendar.lastError ?? "none"}
          </p>
          {result.copy ? (
            <>
              <p>Copy made by calendar mirroring {result.copy.policy}.</p>
              <p>
                {result.copy.source
                  ? `Source event: “${result.copy.source.title}” on ${result.copy.source.calendar}`
                  : "The source event is no longer on its calendar."}
              </p>
            </>
          ) : result.item ? (
            <p>
              Planned by Tempoloom: {result.item.kind} “{result.item.title}”
              {result.item.locked ? ", locked at its time" : ""}.
            </p>
          ) : (
            <p>Tempoloom does not manage this event.</p>
          )}
          {result.policies.length > 0 && (
            <ul>
              {result.policies.map((p) => (
                <li key={p.name}>
                  {p.name}: {p.decision}
                  {p.reason ? ` (${p.reason})` : ""}
                </li>
              ))}
            </ul>
          )}
          <h3>Changes by Tempoloom</h3>
          {result.changes.length === 0 ? (
            <p class="status">No changes by Tempoloom in the last 90 days.</p>
          ) : (
            <ul data-testid="change-log">
              {result.changes.map((c, i) => (
                <li key={`${c.at}-${i}`} data-testid="change-entry">
                  {c.at} · {c.action} · {c.reason}
                  {c.range ? ` · ${c.range}` : ""}
                  {c.actor ? ` · by ${c.actor}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function HelpPage() {
  const slug = path.value.replace(/^\/help\/?/, "");
  if (!slug) return <Index />;
  if (slug === "lookup") return <LookupView />;
  const page = PAGES[slug];
  if (!page) {
    navigate("/help");
    return null;
  }
  return (
    <div class="page help" data-testid="help-page">
      <p>
        <A href="/help">‹ All help topics</A>
      </p>
      <h1>{page.title}</h1>
      {page.body()}
    </div>
  );
}
