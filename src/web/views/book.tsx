// Public booking pages: no sign-in. Times show in the zone the booker picks,
// in a 12- or 24-hour format (docs/specs/booking-links-booking-page.md).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isValidTimeZone, localToUtc } from "../../shared/time.ts";
import { ApiError, api } from "../lib/api.ts";
import { lazyComponent } from "../lib/lazy.ts";
import {
  addPages,
  dayOf,
  dayText,
  FORMAT_KEY,
  savedFormat,
  timeText,
  type View,
} from "../lib/zoned.ts";

interface Question {
  label: string;
  type: "singleLine" | "multiLine" | "choice";
  options: string[];
  required: boolean;
}
interface PublicLink {
  slug: string;
  title: string;
  description: string;
  durations: number[];
  defaultDuration: number | null;
  location: string;
  /** Location options; the first is the default. */
  locations: { kind: "address" | "phone" | "custom"; value: string }[];
  questions: Question[];
  redirectUrl: string | null;
  /** One-off links: the invitee the form starts with (sharing rule 9). */
  prefill: { name: string; email: string } | null;
}
interface Offered {
  start: number;
  end: number;
  preferred: boolean;
}
interface Branding {
  mode: "default" | "none" | "custom";
  logo?: string;
  banner?: string;
  homepage?: string;
}
interface Contact {
  name: string;
  email: string;
}
/** A signed-in person on a booking page (null: signed out). */
interface Viewer {
  zone: string;
  organizer: boolean;
  linkId: string | null;
}
interface MyEvent {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
}

/** The page header's branding (booking page rules 25-31). */
function Brand({ b }: { b: Branding }) {
  if (b.mode === "none") return null;
  if (b.mode === "default") {
    return (
      <header class="brand-header" data-testid="branding">
        <span class="brand-default" data-testid="brand-default">
          Tempoloom
        </span>
      </header>
    );
  }
  const logo = b.logo ? (
    <img src={b.logo} alt="Logo" class="brand-logo" data-testid="brand-logo" />
  ) : null;
  return (
    <header class="brand-header" data-testid="branding">
      {b.banner && <img src={b.banner} alt="" class="brand-banner" data-testid="brand-banner" />}
      {logo && b.homepage ? (
        <a href={b.homepage} data-testid="brand-home">
          {logo}
        </a>
      ) : (
        logo
      )}
    </header>
  );
}

// Only the creator edits a one-off link from its page (sharing rule 13).
const OneOffEditor = lazyComponent<{ linkId: string; onSaved: () => void }>(() =>
  import("./link-personalize.tsx").then((m) => m.OneOffEditor),
);

// Only organizers use the inspector (availability rule 18): load it on demand.
const Inspector = lazyComponent<{
  page: string;
  link: string;
  duration: number;
  view: View;
  startDay: string | null;
}>(() => import("./book-inspector.tsx").then((m) => m.Inspector));

const withWhom = (organizers: string[]) =>
  organizers.length > 0 ? `with ${organizers.join(", ")}` : "";

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Reads the URL parameters once (rule 9). Invalid values are ignored. */
function urlParams() {
  const q = new URLSearchParams(location.search);
  const tz = q.get("tz");
  const day = q.get("day");
  const time = q.get("time");
  const duration = Number(q.get("duration"));
  return {
    tz: tz && isValidTimeZone(tz) ? tz : null,
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) ? day : null,
    time: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
    duration: Number.isInteger(duration) && duration > 0 ? duration : null,
    inspect: q.get("inspect") === "1",
  };
}

/** Keeps a choice in the URL, so a reload shows the same view. */
function setParam(key: string, value: string | null): void {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  history.replaceState(history.state, "", url);
}

function ZonePicker({
  zone,
  calendarZone,
  onChange,
}: {
  zone: string;
  calendarZone: string | null;
  onChange: (zone: string) => void;
}) {
  const [query, setQuery] = useState("");
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  // The actual zones come first, so the booker can compare (rule 6).
  const mine = [browserZone];
  if (calendarZone && calendarZone !== browserZone) mine.push(calendarZone);
  const q = query.trim().toLowerCase().replaceAll(" ", "_");
  const others = [...(zones.includes(zone) ? [] : [zone]), ...zones].filter(
    (z) => !mine.includes(z) && (z === zone || !q || z.toLowerCase().includes(q)),
  );
  return (
    <div class="actions tz-picker" data-testid="tz-picker">
      <label>
        Search time zones
        <input type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <div class="field">
        <label for="tz-select">Time zone</label>
        <select id="tz-select" value={zone} onChange={(e) => onChange(e.currentTarget.value)}>
          <optgroup label="Your time zones">
            <option value={browserZone}>{browserZone} (this browser)</option>
            {mine[1] && <option value={mine[1]}>{mine[1]} (your calendar)</option>}
          </optgroup>
          <optgroup label="All time zones">
            {others.map((z) => (
              <option value={z} key={z}>
                {z}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
    </div>
  );
}

function FormatSwitch({ view, onChange }: { view: View; onChange: (f: "12" | "24") => void }) {
  return (
    <div class="actions" data-testid="time-format">
      {(["24", "12"] as const).map((f) => (
        <button
          type="button"
          key={f}
          aria-pressed={view.format === f}
          onClick={() => {
            localStorage.setItem(FORMAT_KEY, f);
            onChange(f);
          }}
        >
          {f}-hour
        </button>
      ))}
    </div>
  );
}

function Times({
  page,
  link,
  duration,
  token,
  view,
  startDay,
  overlay,
  preselect,
  onPick,
}: {
  page: string;
  link: string;
  duration: number;
  token?: string;
  view: View;
  /** Open on this date (URL parameter `day`). */
  startDay?: string | null;
  /** Show the signed-in booker's own events (rule 10). */
  overlay?: boolean;
  /** Select this start when it is offered (URL parameter `time`). */
  preselect?: { at: number; done: { current: boolean } } | null;
  onPick: (t: Offered) => void;
}) {
  const [times, setTimes] = useState<Offered[] | null>(null);
  const [mine, setMine] = useState<MyEvent[]>([]);
  const [from, setFrom] = useState(() =>
    Math.max(Date.now(), startDay ? localToUtc(view.zone, startDay, 0) : 0),
  );
  useEffect(() => {
    setTimes(null);
    const q = new URLSearchParams({
      duration: String(duration),
      from: String(from),
      to: String(addPages(view, from, 1)),
    });
    if (token) q.set("token", token);
    void api<{ times: Offered[] }>("GET", `/pub/pages/${page}/${link}/times?${q}`).then((r) => {
      setTimes(r.times);
      const pick = preselect && r.times.find((t) => t.start === preselect.at);
      if (preselect && !preselect.done.current) {
        preselect.done.current = true;
        if (pick) onPick(pick);
      }
    });
  }, [page, link, duration, from, token, view.zone]);
  useEffect(() => {
    if (!overlay) {
      setMine([]);
      return;
    }
    void api<{ events: MyEvent[] }>(
      "GET",
      `/api/booking/overlay?from=${from}&to=${addPages(view, from, 1)}`,
    ).then((r) => setMine(r.events));
  }, [overlay, from, view.zone]);
  const byDay = useMemo(() => {
    const m = new Map<string, Offered[]>();
    for (const t of times ?? [])
      m.set(dayOf(view, t.start), [...(m.get(dayOf(view, t.start)) ?? []), t]);
    return [...m.entries()];
  }, [times, view.zone]);
  if (times === null) return <p class="status">Loading times…</p>;
  const busyForMe = (t: Offered) =>
    mine.some((e) => !e.allDay && e.start < t.end && e.end > t.start);
  return (
    <div data-testid="times">
      {byDay.length === 0 && <p>No free times in these two weeks.</p>}
      {times.some((t) => t.preferred) && (
        <p class="status" data-testid="preferred-legend">
          <span class="dot" aria-hidden="true" /> Preferred: the organizer has nothing else then.
        </p>
      )}
      {byDay.map(([date, day]) => {
        const first = day[0]?.start ?? 0;
        const events = mine.filter(
          (e) => dayOf(view, e.start) <= date && dayOf(view, Math.max(e.start, e.end - 1)) >= date,
        );
        return (
          <div class="day-times" key={date} data-testid="day-times" data-day={date}>
            <h3>{dayText(view, first)}</h3>
            {overlay && events.length > 0 && (
              <ul class="my-events" data-testid="my-events">
                {events.map((e) => (
                  <li key={`${e.start}-${e.title}`}>
                    {e.allDay
                      ? `All day ${e.title}`
                      : `${timeText(view, e.start)}–${timeText(view, e.end)} ${e.title}`}
                  </li>
                ))}
              </ul>
            )}
            <div class="actions">
              {day.map((t) => (
                <button
                  type="button"
                  key={t.start}
                  data-start={t.start}
                  data-mine={overlay && busyForMe(t) ? "busy" : undefined}
                  class={t.preferred ? "preferred" : ""}
                  data-preferred={t.preferred ? "1" : undefined}
                  title={t.preferred ? "Preferred" : undefined}
                  onClick={() => onPick(t)}
                >
                  {t.preferred && <span class="dot" aria-hidden="true" />}
                  {timeText(view, t.start)}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div class="actions">
        {from > Date.now() + 1000 && (
          <button
            type="button"
            onClick={() => setFrom((f) => Math.max(Date.now(), addPages(view, f, -1)))}
          >
            Earlier
          </button>
        )}
        {/* From the newest value: a quick second click must move two weeks more. */}
        <button type="button" onClick={() => setFrom((f) => addPages(view, f, 1))}>
          Later
        </button>
      </div>
    </div>
  );
}

interface LinkInfo {
  link: PublicLink;
  organizers: string[];
  branding: Branding;
  oneOff: { expiresAt: number; expired: boolean } | null;
  /** The link takes no new bookings: its account for booked events is lost. */
  paused?: boolean;
}

const LOCATION_KINDS = { address: "Address", phone: "Phone", custom: "Other" } as const;

interface Booked {
  token: string;
  location?: string;
  start: number;
  end: number;
  organizers: string[];
  assignee: Contact | null;
}

const REDIRECT_DELAY = 7_000;

type EmbedRedirect = "disabled" | "topPage" | "frame";

/** Inside a website embed: the redirect mode of its code (sharing rule 25); null when not embedded. */
const embedMode = (): EmbedRedirect | null => {
  const q = new URLSearchParams(location.search);
  if (q.get("embed") !== "1" || window.parent === window) return null;
  const mode = q.get("redirect");
  return mode === "topPage" || mode === "frame" ? mode : "disabled";
};

function Confirmation({ info, done, view }: { info: LinkInfo; done: Booked; view: View }) {
  const mode = useMemo(embedMode, []);
  const url = mode === "disabled" ? null : info.link.redirectUrl;
  useEffect(() => {
    if (!url) return;
    // Rule 17: the confirmation shows first; the page goes on 7 seconds later.
    const timer = setTimeout(() => {
      if (mode !== "topPage") {
        location.assign(url);
        return;
      }
      // The embed script moves the host page; a plain frame moves it itself.
      window.parent.postMessage({ type: "tempoloom:redirect", url }, "*");
      try {
        (window.top ?? window).location.href = url;
      } catch {}
    }, REDIRECT_DELAY);
    return () => clearTimeout(timer);
  }, [url, mode]);
  return (
    <div data-testid="booked">
      <Brand b={info.branding} />
      <h2>You are booked</h2>
      <p>
        {info.link.title} {withWhom(done.organizers)}, {dayText(view, done.start)},{" "}
        {timeText(view, done.start)} to {timeText(view, done.end)} ({view.zone}).
      </p>
      {(done.location ?? info.link.location) && (
        <p class="status" data-testid="booked-location">
          Location: {done.location ?? info.link.location}
        </p>
      )}
      {done.assignee && (
        <p data-testid="booked-host">
          Your meeting is with {done.assignee.name} ({done.assignee.email}).
        </p>
      )}
      <p>
        <a href={`/book/manage/${done.token}`} data-testid="manage-link">
          Reschedule or cancel
        </a>
      </p>
      {url && (
        <p class="status" data-testid="redirect-note">
          You will go to {url} in 7 seconds.
        </p>
      )}
    </div>
  );
}

function DetailsForm({
  page,
  link,
  info,
  picked,
  duration,
  view,
  onDone,
  onTaken,
  onChange,
}: {
  page: string;
  link: string;
  info: LinkInfo;
  picked: Offered;
  duration: number;
  view: View;
  onDone: (b: Booked) => void;
  onTaken: () => void;
  onChange: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const questions = info.link.questions;
  return (
    <form
      class="form"
      data-testid="book-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget as HTMLFormElement);
        const answers = questions.map((_, i) => String(f.get(`answer-${i}`) ?? "").trim());
        const missing = questions.find((q, i) => q.required && !answers[i]);
        if (missing) {
          setError(`Answer the question: ${missing.label}`);
          return;
        }
        setError(null);
        api<Booked>("POST", `/pub/pages/${page}/${link}/book`, {
          start: picked.start,
          duration,
          name: f.get("name"),
          email: f.get("email"),
          message: f.get("message") || undefined,
          answers,
          cc: String(f.get("cc") ?? "")
            .split(/[,\s]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          ...(info.link.locations.length > 1 ? { location: Number(f.get("location")) } : {}),
          timeZone: view.zone,
          params: [...new URLSearchParams(location.search)].filter(([k]) => k.startsWith("data-")),
        })
          .then(onDone)
          .catch((err) => {
            if (
              err instanceof ApiError &&
              (err.body as { error?: string } | null)?.error === "no_travel_time"
            ) {
              setError(
                "This time leaves no travel time for that location. Pick another location or time.",
              );
            } else if (err instanceof ApiError && err.status === 409) {
              onTaken();
            } else if (err instanceof ApiError && err.status === 400) {
              setError(
                "Answer the required questions, pick from the choices given, and check the CC addresses.",
              );
            } else setError("The booking failed. Please try again.");
          });
      }}
    >
      <p class="wide">
        {dayText(view, picked.start)}, {timeText(view, picked.start)} to{" "}
        {timeText(view, picked.end)}{" "}
        <button type="button" onClick={onChange}>
          Change
        </button>
      </p>
      <label>
        Your name
        <input name="name" required maxLength={200} defaultValue={info.link.prefill?.name ?? ""} />
      </label>
      <label>
        Your email
        <input name="email" type="email" required defaultValue={info.link.prefill?.email ?? ""} />
      </label>
      <label class="wide">
        CC (optional, comma list, up to 10)
        <input name="cc" placeholder="ana@example.com, ben@example.com" />
      </label>
      {info.link.locations.length > 1 && (
        <label class="wide">
          Location
          <select name="location">
            {info.link.locations.map((l, i) => (
              <option value={i} key={`${i}-${l.value}`}>
                {LOCATION_KINDS[l.kind]}: {l.value}
              </option>
            ))}
          </select>
        </label>
      )}
      <label class="wide">
        Message (optional)
        <textarea name="message" rows={3} />
      </label>
      {questions.map((q, i) => {
        const id = `answer-${i}`;
        return (
          <div class="wide question" key={`${i}-${q.label}`}>
            <label for={id} data-testid="question">
              {q.label}
              {q.required ? " (required)" : ""}
            </label>
            {q.type === "multiLine" ? (
              <textarea id={id} name={id} rows={3} />
            ) : q.type === "choice" ? (
              <select id={id} name={id}>
                <option value="">Choose</option>
                {q.options.map((o) => (
                  <option value={o} key={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input id={id} name={id} maxLength={4000} />
            )}
          </div>
        );
      })}
      {error && (
        <p class="error wide" role="alert">
          {error}
        </p>
      )}
      <button type="submit" class="primary">
        Book
      </button>
    </form>
  );
}

const OVERLAY_KEY = "tl-overlay";

function BookingPage({ page, link }: { page: string; link: string }) {
  const params = useMemo(urlParams, []);
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [view, setView] = useState<View>(() => ({
    zone: params.tz ?? browserZone,
    format: savedFormat(),
  }));
  const [duration, setDuration] = useState<number | null>(null);
  const [picked, setPicked] = useState<Offered | null>(null);
  const [done, setDone] = useState<Booked | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(() => localStorage.getItem(OVERLAY_KEY) === "1");
  const [inspect, setInspect] = useState(params.inspect);
  const [editing, setEditing] = useState(false);
  const preselectDone = useRef(false);
  useEffect(() => {
    api<LinkInfo>("GET", `/pub/pages/${page}/${link}`)
      .then((r) => {
        setInfo(r);
        const d = r.link.durations;
        setDuration(
          params.duration && d.includes(params.duration)
            ? params.duration
            : (r.link.defaultDuration ?? d[0] ?? null),
        );
      })
      .catch(() => setMissing(true));
    // Signed-in people get their calendar zone and the overlay; others get a 401.
    api<Viewer>("GET", `/api/booking/viewer?page=${page}&link=${link}`)
      .then(setViewer)
      .catch(() => setViewer(null));
  }, [page, link]);
  if (missing) return <p>This booking link does not exist.</p>;
  if (!info || duration === null) return null;
  if (done) return <Confirmation info={info} done={done} view={view} />;
  const editOneOff = viewer?.organizer && info.oneOff && viewer.linkId && (
    <div class="actions">
      {editing ? (
        <OneOffEditor linkId={viewer.linkId} onSaved={() => location.reload()} />
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          Edit this link
        </button>
      )}
    </div>
  );
  if (info.oneOff?.expired) {
    return (
      <div data-testid="booking-page">
        <Brand b={info.branding} />
        <h1>{info.link.title}</h1>
        <p data-testid="expired">
          This link has expired. Ask {info.organizers.join(", ") || "the organizer"} for a new one.
        </p>
        {editOneOff}
      </div>
    );
  }
  if (info.paused) {
    return (
      <div data-testid="booking-page">
        <Brand b={info.branding} />
        <h1>{info.link.title}</h1>
        <p data-testid="paused">
          This link takes no bookings right now. Ask the organizer for another way to meet.
        </p>
      </div>
    );
  }
  const preselect =
    params.day && params.time
      ? {
          at: localToUtc(
            view.zone,
            params.day,
            Number(params.time.slice(0, 2)) * 60 + Number(params.time.slice(3)),
          ),
          done: preselectDone,
        }
      : null;
  return (
    <div data-testid="booking-page">
      <Brand b={info.branding} />
      <h1>{info.link.title}</h1>
      {info.organizers.length > 0 && <p class="status">{withWhom(info.organizers)}</p>}
      {info.link.description && <p>{info.link.description}</p>}
      {info.link.location && <p class="status">Location: {info.link.location}</p>}
      {editOneOff}
      {info.link.durations.length > 1 && (
        <div class="actions" data-testid="durations">
          {info.link.durations.map((d) => (
            <button
              type="button"
              key={d}
              aria-pressed={d === duration}
              onClick={() => {
                setDuration(d);
                setPicked(null);
                setParam("duration", String(d));
              }}
            >
              {d} min
            </button>
          ))}
        </div>
      )}
      <ZonePicker
        zone={view.zone}
        calendarZone={viewer?.zone ?? null}
        onChange={(zone) => {
          setView({ ...view, zone });
          setParam("tz", zone);
        }}
      />
      <FormatSwitch view={view} onChange={(format) => setView({ ...view, format })} />
      <p class="status" data-testid="tz-note">
        Times are in {view.zone}.
        {view.zone !== browserZone && ` Your browser's time zone is ${browserZone}.`}
      </p>
      {viewer && (
        <label class="inline">
          <input
            type="checkbox"
            checked={overlay}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              localStorage.setItem(OVERLAY_KEY, on ? "1" : "0");
              setOverlay(on);
            }}
          />
          Show my calendar
        </label>
      )}
      {viewer?.organizer && (
        <label class="inline">
          <input
            type="checkbox"
            checked={inspect}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              setParam("inspect", on ? "1" : null);
              setInspect(on);
            }}
          />
          Inspect availability
        </label>
      )}
      {notice && (
        <p class="error" role="alert">
          {notice}
        </p>
      )}
      {inspect && viewer?.organizer ? (
        <Inspector
          key={`${duration}-${view.zone}`}
          page={page}
          link={link}
          duration={duration}
          view={view}
          startDay={params.day}
        />
      ) : !picked ? (
        <Times
          key={`${duration}-${view.zone}`}
          page={page}
          link={link}
          duration={duration}
          view={view}
          startDay={params.day}
          overlay={overlay && viewer !== null}
          preselect={preselect}
          onPick={(t) => {
            setNotice(null);
            setPicked(t);
          }}
        />
      ) : (
        <DetailsForm
          page={page}
          link={link}
          info={info}
          picked={picked}
          duration={duration}
          view={view}
          onDone={setDone}
          onTaken={() => {
            setNotice("Someone just took this time. Please pick another one.");
            setPicked(null);
          }}
          onChange={() => setPicked(null)}
        />
      )}
    </div>
  );
}

function PageLinks({ page }: { page: string }) {
  const [data, setData] = useState<{
    name: string;
    /** A link group's title; null for a main booking page. */
    title: string | null;
    links: PublicLink[];
    branding: Branding;
  } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api<NonNullable<typeof data>>("GET", `/pub/pages/${page}`)
      .then(setData)
      .catch(() => setMissing(true));
  }, [page]);
  if (missing) return <p>This booking page does not exist.</p>;
  if (!data) return null;
  return (
    <div data-testid="public-page">
      <Brand b={data.branding} />
      <h1>{data.title ?? `Book time with ${data.name}`}</h1>
      {data.links.length === 0 && <p>This page has no links yet.</p>}
      <div class="list">
        {data.links.map((l) => (
          <a class="row" href={`/book/${page}/${l.slug}`} key={l.slug} data-testid="public-link">
            <span>{l.title}</span>
            <span class="meta">{l.durations.join(", ")} min</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function Manage({ token }: { token: string }) {
  const action = useMemo(() => new URLSearchParams(location.search).get("action"), []);
  const [data, setData] = useState<{
    booking: { start: number; end: number; name: string; status: string; timeZone: string };
    link: PublicLink | null;
    page: string | null;
    assignee: Contact | null;
  } | null>(null);
  const [mode, setMode] = useState<"view" | "reschedule">(
    action === "reschedule" ? "reschedule" : "view",
  );
  const [message, setMessage] = useState<string | null>(null);
  const load = () =>
    void api<NonNullable<typeof data>>("GET", `/pub/bookings/${token}`).then(setData);
  useEffect(load, [token]);
  if (!data) return null;
  const { booking, link, page } = data;
  const view: View = {
    zone: isValidTimeZone(booking.timeZone) ? booking.timeZone : browserZone,
    format: savedFormat(),
  };
  const booked = booking.status === "booked";
  return (
    <div data-testid="manage-page">
      <h1>{link?.title ?? "Booking"}</h1>
      <p data-testid="booking-status">
        {booked
          ? `${dayText(view, booking.start)}, ${timeText(view, booking.start)} to ${timeText(view, booking.end)} (${view.zone})`
          : "Cancelled"}
      </p>
      {data.assignee && (
        <p data-testid="booking-host">
          With {data.assignee.name} ({data.assignee.email})
        </p>
      )}
      {message && <p class="status">{message}</p>}
      {booked && action === "cancel" && mode === "view" && (
        <p class="status" data-testid="cancel-confirm">
          Do you want to cancel this booking? The organizers get an email.
        </p>
      )}
      {booked && mode === "view" && (
        <div class="actions">
          {link && page && (
            <button type="button" onClick={() => setMode("reschedule")}>
              Reschedule
            </button>
          )}
          <button
            type="button"
            class="danger"
            onClick={() =>
              void api("POST", `/pub/bookings/${token}/cancel`).then(() => {
                setMessage("Your booking is cancelled.");
                load();
              })
            }
          >
            Cancel booking
          </button>
        </div>
      )}
      {booked && mode === "reschedule" && link && page && (
        <Times
          page={page}
          link={link.slug}
          duration={(booking.end - booking.start) / 60_000}
          token={token}
          view={view}
          onPick={(t) =>
            void api("POST", `/pub/bookings/${token}/reschedule`, {
              start: t.start,
              timeZone: view.zone,
            }).then(() => {
              setMode("view");
              setMessage("Your booking has a new time.");
              load();
            })
          }
        />
      )}
    </div>
  );
}

export function PublicBooking({ path }: { path: string }) {
  const embedded = useMemo(() => embedMode() !== null, []);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!embedded || !el) return;
    // The embed script sizes the frame to the page (sharing rule 24).
    const send = () =>
      window.parent.postMessage(
        { type: "tempoloom:height", height: el.getBoundingClientRect().height + 1 },
        "*",
      );
    const watch = new ResizeObserver(send);
    watch.observe(el);
    return () => watch.disconnect();
  }, [embedded]);
  const parts = path.split("/").filter(Boolean).slice(1);
  let body = <p>Not found.</p>;
  if (parts[0] === "manage" && parts[1]) body = <Manage token={parts[1]} />;
  else if (parts.length === 1 && parts[0]) body = <PageLinks page={parts[0]} />;
  else if (parts.length === 2 && parts[0] && parts[1])
    body = <BookingPage page={parts[0]} link={parts[1]} />;
  return (
    <div class={embedded ? "public page embedded" : "public page"} ref={root}>
      {body}
    </div>
  );
}
