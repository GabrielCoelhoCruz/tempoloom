import { useCallback, useEffect, useState } from "preact/hooks";
import { api } from "../lib/api.ts";
import { formatWhen } from "../lib/format.ts";
import { LEVEL_NAMES, zone } from "../lib/state.ts";

interface Link {
  id: string;
  slug: string;
  title: string;
  durations: number[];
  level: number;
  hidden: number;
}

interface Booking {
  id: string;
  start_ms: number;
  name: string;
  email: string;
  status: string;
  link_title: string | null;
}

export function Links() {
  const z = zone();
  const [page, setPage] = useState<string | null | undefined>(undefined);
  const [links, setLinks] = useState<Link[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = await api<{ slug: string | null }>("GET", "/api/booking/page");
    setPage(p.slug);
    if (p.slug) {
      const [l, b] = await Promise.all([
        api<{ links: Link[] }>("GET", "/api/booking/links"),
        api<{ bookings: Booking[] }>("GET", "/api/booking/bookings"),
      ]);
      setLinks(l.links);
      setBookings(b.bookings);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      const body = (err as { body?: { error?: string; issues?: { message: string }[] } }).body;
      setError(body?.issues?.[0]?.message ?? body?.error ?? String(err));
    }
  };

  if (page === undefined) return null;
  if (page === null) {
    return (
      <div class="page" data-testid="links-page" key="claim">
        <h1>Booking links</h1>
        <p>Choose the address of your booking page. People open it to book time with you.</p>
        <form
          class="form"
          data-testid="claim-form"
          onSubmit={(e) => {
            e.preventDefault();
            const slug = String(new FormData(e.currentTarget as HTMLFormElement).get("slug") ?? "");
            void act(() => api("POST", "/api/booking/page", { slug }));
          }}
        >
          <label>
            Page address
            <input name="slug" required pattern="[a-z0-9][a-z0-9-]*" placeholder="your-name" />
          </label>
          <button type="submit" class="primary">
            Create booking page
          </button>
        </form>
        {error && <p class="error">{error}</p>}
      </div>
    );
  }

  const url = (slug?: string) => `${location.origin}/book/${page}${slug ? `/${slug}` : ""}`;
  return (
    <div class="page" data-testid="links-page" key="links">
      <h1>Booking links</h1>
      <p class="status">
        Your page:{" "}
        <a href={url()} data-testid="page-url">
          {url()}
        </a>
      </p>
      <form
        class="form"
        data-testid="link-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget as HTMLFormElement);
          const num = (k: string) =>
            f.get(k) === "" || f.get(k) === null ? null : Number(f.get(k));
          const durations = String(f.get("durations") ?? "")
            .split(",")
            .map((d) => Number(d.trim()))
            .filter((d) => d > 0);
          void act(() =>
            api("POST", "/api/booking/links", {
              title: String(f.get("title") ?? ""),
              durations,
              level: Number(f.get("level")),
              noticeMinutes: Number(f.get("notice")) * 60,
              rangeEndDays: Number(f.get("rangeEndDays")),
              bufferBefore: Number(f.get("bufferBefore")),
              bufferAfter: Number(f.get("bufferAfter")),
              maxPerDay: num("maxPerDay"),
              location: String(f.get("location") ?? ""),
              hidden: f.get("hidden") === "on",
            }),
          );
        }}
      >
        <label class="wide">
          Title
          <input name="title" required maxLength={120} />
        </label>
        <label>
          Durations (minutes, comma list)
          <input name="durations" defaultValue="30" required />
        </label>
        <label>
          Priority
          <select name="level">
            {[1, 2, 3, 4].map((l) => (
              <option value={l} key={l} selected={l === 2}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Notice (hours)
          <input name="notice" type="number" min={0} defaultValue="4" />
        </label>
        <label>
          Book up to (days ahead)
          <input name="rangeEndDays" type="number" min={0} max={100} defaultValue="30" />
        </label>
        <label>
          Buffer before (minutes)
          <input name="bufferBefore" type="number" min={0} max={120} defaultValue="0" />
        </label>
        <label>
          Buffer after (minutes)
          <input name="bufferAfter" type="number" min={0} max={120} defaultValue="0" />
        </label>
        <label>
          Most bookings per day
          <input name="maxPerDay" type="number" min={1} max={50} />
        </label>
        <label>
          Location
          <input name="location" />
        </label>
        <label class="inline">
          <input name="hidden" type="checkbox" />
          Hide from my page (direct link only)
        </label>
        <button type="submit" class="primary">
          Add link
        </button>
      </form>
      {error && <p class="error">{error}</p>}
      <div class="list" data-testid="link-list">
        {links.map((l) => (
          <div class="row" key={l.id} data-testid="link-row" data-link-title={l.title}>
            <div>
              <div>
                {l.title} {l.hidden ? <span class="badge">hidden</span> : null}
              </div>
              <div class="meta">
                {LEVEL_NAMES[l.level]} · {l.durations.join(", ")} min ·{" "}
                <a href={url(l.slug)} data-testid="link-url">
                  {url(l.slug)}
                </a>
              </div>
            </div>
            <div class="actions">
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(url(l.slug))}
              >
                Copy link
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => void act(() => api("DELETE", `/api/booking/links/${l.id}`))}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      <h2>Bookings</h2>
      <div class="list" data-testid="booking-list">
        {bookings.map((b) => (
          <div class="row" key={b.id}>
            <span>
              {formatWhen(z, b.start_ms)} · {b.name} ({b.email}) · {b.link_title ?? "deleted link"}
            </span>
            <span class="badge">{b.status}</span>
          </div>
        ))}
        {bookings.length === 0 && <p class="status">No bookings yet.</p>}
      </div>
    </div>
  );
}
