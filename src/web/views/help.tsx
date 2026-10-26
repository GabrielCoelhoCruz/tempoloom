// Help (docs/specs/support-troubleshooting.md): the troubleshooting index, one
// page per problem with the fix, and the event lookup with Tempoloom's change log.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { HELP_PAGES, type HelpBlock, helpInline } from "../../shared/help-pages.ts";
import { ApiError, api } from "../lib/api.ts";
import { useNewest } from "../lib/newest.ts";
import { navigate, onLinkClick, path } from "../lib/router.ts";

function A({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} onClick={onLinkClick}>
      {children}
    </a>
  );
}

/** A text of the help pages, with its [label](/path) links. */
function Text({ text }: { text: string }) {
  return (
    <>
      {helpInline(text).map((x, i) =>
        typeof x === "string" ? (
          x
        ) : (
          <A key={i} href={x.href}>
            {x.label}
          </A>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: HelpBlock }) {
  if ("p" in block)
    return (
      <p>
        <Text text={block.p} />
      </p>
    );
  if ("warning" in block)
    return (
      <p class="warning">
        <Text text={block.warning} />
      </p>
    );
  const items = "ul" in block ? block.ul : block.ol;
  const lis = items.map((x) => (
    <li key={x}>
      <Text text={x} />
    </li>
  ));
  return "ul" in block ? <ul>{lis}</ul> : <ol>{lis}</ol>;
}

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
                <A href={`/help/${slug}`}>{label || HELP_PAGES[slug]?.title}</A>
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
  repairable: boolean;
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
  const [repairing, setRepairing] = useState<"busy" | "done" | null>(null);
  // The query of the result on the page: repair acts on that event, also after the input changes.
  const [shown, setShown] = useState("");
  // Each query has its own URL: only the newest lookup may draw.
  const newest = useNewest();
  const run = async (value: string) => {
    const isNewest = newest();
    setError(null);
    setRepairing(null);
    setResult(null);
    if (!value.trim()) return;
    try {
      const r = await api<Lookup>("GET", `/api/help/lookup?q=${encodeURIComponent(value)}`);
      if (!isNewest()) return;
      setResult(r);
      setShown(value);
    } catch (err) {
      if (!isNewest()) return;
      const code = err instanceof ApiError ? (err.body as { error?: string })?.error : undefined;
      setError(ERRORS[code ?? ""] ?? "The lookup failed. Try again.");
    }
  };
  // Rule 10: the copy decision runs again for this one event, and its result is written.
  const repair = async () => {
    setError(null);
    setRepairing("busy");
    try {
      setResult(await api<Lookup>("POST", "/api/help/repair", { q: shown }));
      setRepairing("done");
    } catch (err) {
      setRepairing(null);
      // 502: the run failed or left the event as it was; the lookup shows the event now.
      const body = err instanceof ApiError ? (err.body as Lookup | undefined) : undefined;
      if (body?.event) setResult(body);
      setError("The repair failed: the event is as it was. Try again later.");
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
          {result.repairable && (
            <div class="actions">
              <button type="button" disabled={repairing === "busy"} onClick={() => void repair()}>
                Repair
              </button>
              {repairing === "done" && (
                <span class="status" role="status" data-testid="repair-message">
                  Repaired: Tempoloom wrote this event again as its copy rules give it.
                </span>
              )}
            </div>
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
  const page = HELP_PAGES[slug];
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
      {page.body.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
