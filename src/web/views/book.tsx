// Public booking pages: no sign-in. Times show in the booker's own time zone.
import { useEffect, useMemo, useState } from "preact/hooks";
import { ApiError, api } from "../lib/api.ts";

interface PublicLink {
  slug: string;
  title: string;
  description: string;
  durations: number[];
  location: string;
}
interface Offered {
  start: number;
  end: number;
  preferred: boolean;
}

const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayLabel = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const timeLabel = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayKey = (t: number) => new Date(t).toLocaleDateString("sv-SE");
const SPAN = 14 * 86_400_000;

function Times({
  page,
  link,
  duration,
  token,
  onPick,
}: {
  page: string;
  link: string;
  duration: number;
  token?: string;
  onPick: (t: Offered) => void;
}) {
  const [times, setTimes] = useState<Offered[] | null>(null);
  const [from, setFrom] = useState(() => Date.now());
  useEffect(() => {
    setTimes(null);
    const q = new URLSearchParams({
      duration: String(duration),
      from: String(from),
      to: String(from + SPAN),
    });
    if (token) q.set("token", token);
    void api<{ times: Offered[] }>("GET", `/pub/pages/${page}/${link}/times?${q}`).then((r) =>
      setTimes(r.times),
    );
  }, [page, link, duration, from, token]);
  const byDay = useMemo(() => {
    const m = new Map<string, Offered[]>();
    for (const t of times ?? []) m.set(dayKey(t.start), [...(m.get(dayKey(t.start)) ?? []), t]);
    return [...m.values()];
  }, [times]);
  if (times === null) return <p class="status">Loading times…</p>;
  return (
    <div data-testid="times">
      <p class="status">Times are in your time zone ({viewerZone}).</p>
      {byDay.length === 0 && <p>No free times in the next two weeks.</p>}
      {byDay.map((day) => (
        <div class="day-times" key={dayKey(day[0]?.start ?? 0)} data-testid="day-times">
          <h3>{dayLabel(day[0]?.start ?? 0)}</h3>
          <div class="actions">
            {day.map((t) => (
              <button
                type="button"
                key={t.start}
                data-start={t.start}
                class={t.preferred ? "preferred" : ""}
                onClick={() => onPick(t)}
              >
                {timeLabel(t.start)}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div class="actions">
        {from > Date.now() + 1000 && (
          <button type="button" onClick={() => setFrom(Math.max(Date.now(), from - SPAN))}>
            Earlier
          </button>
        )}
        <button type="button" onClick={() => setFrom(from + SPAN)}>
          Later
        </button>
      </div>
    </div>
  );
}

function BookingPage({ page, link }: { page: string; link: string }) {
  const [info, setInfo] = useState<{ link: PublicLink; organizer: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [picked, setPicked] = useState<Offered | null>(null);
  const [done, setDone] = useState<{ token: string; start: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ link: PublicLink; organizer: string }>("GET", `/pub/pages/${page}/${link}`)
      .then((r) => {
        setInfo(r);
        setDuration(r.link.durations[0] ?? null);
      })
      .catch(() => setMissing(true));
  }, [page, link]);
  if (missing) return <p>This booking link does not exist.</p>;
  if (!info || duration === null) return null;
  if (done) {
    return (
      <div data-testid="booked">
        <h2>You are booked</h2>
        <p>
          {info.link.title} with {info.organizer}, {dayLabel(done.start)} at {timeLabel(done.start)}
          .
        </p>
        <p>
          <a href={`/book/manage/${done.token}`} data-testid="manage-link">
            Reschedule or cancel
          </a>
        </p>
      </div>
    );
  }
  return (
    <div data-testid="booking-page">
      <h1>{info.link.title}</h1>
      <p class="status">with {info.organizer}</p>
      {info.link.description && <p>{info.link.description}</p>}
      {info.link.location && <p class="status">Location: {info.link.location}</p>}
      {info.link.durations.length > 1 && (
        <div class="actions" data-testid="durations">
          {info.link.durations.map((d) => (
            <button
              type="button"
              key={d}
              aria-pressed={d === duration}
              onClick={() => setDuration(d)}
            >
              {d} min
            </button>
          ))}
        </div>
      )}
      {!picked ? (
        <Times page={page} link={link} duration={duration} onPick={setPicked} />
      ) : (
        <form
          class="form"
          data-testid="book-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget as HTMLFormElement);
            setError(null);
            api<{ token: string; start: number }>("POST", `/pub/pages/${page}/${link}/book`, {
              start: picked.start,
              duration,
              name: f.get("name"),
              email: f.get("email"),
              message: f.get("message") || undefined,
              params: [...new URLSearchParams(location.search)].filter(([k]) =>
                k.startsWith("data-"),
              ),
            })
              .then(setDone)
              .catch((err) => {
                if (err instanceof ApiError && err.status === 409) {
                  setError("Someone just took this time. Please pick another one.");
                  setPicked(null);
                } else setError("The booking failed. Please try again.");
              });
          }}
        >
          <p class="wide">
            {dayLabel(picked.start)}, {timeLabel(picked.start)} to {timeLabel(picked.end)}{" "}
            <button type="button" onClick={() => setPicked(null)}>
              Change
            </button>
          </p>
          <label>
            Your name
            <input name="name" required maxLength={200} />
          </label>
          <label>
            Your email
            <input name="email" type="email" required />
          </label>
          <label class="wide">
            Message (optional)
            <textarea name="message" rows={3} />
          </label>
          <button type="submit" class="primary">
            Book
          </button>
        </form>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PageLinks({ page }: { page: string }) {
  const [data, setData] = useState<{ name: string; links: PublicLink[] } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api<{ name: string; links: PublicLink[] }>("GET", `/pub/pages/${page}`)
      .then(setData)
      .catch(() => setMissing(true));
  }, [page]);
  if (missing) return <p>This booking page does not exist.</p>;
  if (!data) return null;
  return (
    <div data-testid="public-page">
      <h1>Book time with {data.name}</h1>
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
  const [data, setData] = useState<{
    booking: { start: number; end: number; name: string; status: string };
    link: PublicLink | null;
    page: string | null;
  } | null>(null);
  const [mode, setMode] = useState<"view" | "reschedule">("view");
  const [message, setMessage] = useState<string | null>(null);
  const load = () =>
    void api<NonNullable<typeof data>>("GET", `/pub/bookings/${token}`).then(setData);
  useEffect(load, [token]);
  if (!data) return null;
  const { booking, link, page } = data;
  return (
    <div data-testid="manage-page">
      <h1>{link?.title ?? "Booking"}</h1>
      <p data-testid="booking-status">
        {booking.status === "cancelled"
          ? "Cancelled"
          : `${dayLabel(booking.start)} at ${timeLabel(booking.start)}`}
      </p>
      {message && <p class="status">{message}</p>}
      {booking.status === "booked" && mode === "view" && (
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
      {mode === "reschedule" && link && page && (
        <Times
          page={page}
          link={link.slug}
          duration={(booking.end - booking.start) / 60_000}
          token={token}
          onPick={(t) =>
            void api("POST", `/pub/bookings/${token}/reschedule`, { start: t.start }).then(() => {
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
  const parts = path.split("/").filter(Boolean).slice(1);
  let body = <p>Not found.</p>;
  if (parts[0] === "manage" && parts[1]) body = <Manage token={parts[1]} />;
  else if (parts.length === 1 && parts[0]) body = <PageLinks page={parts[0]} />;
  else if (parts.length === 2 && parts[0] && parts[1])
    body = <BookingPage page={parts[0]} link={parts[1]} />;
  return <div class="public page">{body}</div>;
}
