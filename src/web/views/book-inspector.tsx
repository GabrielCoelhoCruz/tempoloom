// The availability inspector of a booking page, for the link's organizers
// (docs/specs/booking-links-availability.md rules 18-22). Loaded on demand.
import { useEffect, useMemo, useState } from "preact/hooks";
import { localToUtc, utcToLocal } from "../../shared/time.ts";
import { api } from "../lib/api.ts";
import { useNewest } from "../lib/newest.ts";
import { addPages, dayOf, dayText, timeText, type View } from "../lib/zoned.ts";

type Reason =
  | "past"
  | "beforeRangeStart"
  | "afterRangeEnd"
  | "limitReached"
  | "startInterval"
  | "outsideHours"
  | "buffer"
  | "conflict"
  | "higherPriority";

interface Failure {
  code: Reason;
  person: { name: string; email: string } | null;
  /** The blocking event; `title` is null when the viewer may not see it. */
  event: { title: string | null } | null;
  settings: { label: string; href: string }[];
}
interface Inspected {
  start: number;
  end: number;
  offered: boolean;
  preferred: boolean;
  failures: Failure[];
}

/** Proposed colors of rule 20. */
const COLOR: Record<Reason, string> = {
  past: "grey",
  beforeRangeStart: "grey",
  afterRangeEnd: "grey",
  limitReached: "orange",
  startInterval: "orange",
  outsideHours: "orange",
  buffer: "purple",
  conflict: "red",
  higherPriority: "blue",
};

function explain(f: Failure): string {
  const who = f.person?.name || f.person?.email || "";
  const what = f.event ? (f.event.title ?? "a busy event") : "";
  switch (f.code) {
    case "past":
      return "This time has passed.";
    case "beforeRangeStart":
      return "Too soon: the link needs more notice.";
    case "afterRangeEnd":
      return "Too far ahead: after the link's last bookable day.";
    case "limitReached":
      return "The link already has its most bookings for this day or week.";
    case "startInterval":
      return `${who} does not start meetings at this minute.`;
    case "outsideHours":
      return `Outside ${who}'s hours for this link.`;
    case "buffer":
      return `No room for the buffer next to ${what} of ${who}.`;
    case "conflict":
      return `${who} has ${what} at this time.`;
    case "higherPriority":
      return `${who} has ${what}, with the same or a higher priority than the link.`;
  }
}

export function Inspector({
  page,
  link,
  duration,
  view,
  startDay,
}: {
  page: string;
  link: string;
  duration: number;
  view: View;
  startDay: string | null;
}) {
  const today = utcToLocal(view.zone, Date.now()).date;
  const [from, setFrom] = useState(() => localToUtc(view.zone, startDay ?? today, 0));
  const [data, setData] = useState<{ until: number; times: Inspected[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  // Each page has its own URL: only the newest load may draw.
  const newest = useNewest();
  useEffect(() => {
    const isNewest = newest();
    setData(null);
    const q = new URLSearchParams({
      page,
      link,
      duration: String(duration),
      from: String(from),
      to: String(addPages(view, from, 1)),
    });
    void api<{ until: number; times: Inspected[] }>("GET", `/api/booking/inspect?${q}`).then(
      (r) => {
        if (isNewest()) setData(r);
      },
    );
  }, [page, link, duration, from, view.zone]);
  const days = useMemo(() => {
    const m = new Map<string, Inspected[]>();
    for (const t of data?.times ?? []) {
      const d = dayOf(view, t.start);
      m.set(d, [...(m.get(d) ?? []), t]);
    }
    return [...m.entries()];
  }, [data, view.zone]);
  if (!data) return <p class="status">Loading times…</p>;
  const first = localToUtc(view.zone, today, 0);
  return (
    <div data-testid="inspector">
      <p class="status">
        Every time of each day, offered or not. A dot shows each check that fails; select a time to
        see why. Bookers never see this.
      </p>
      {days.length === 0 && <p>No hours in these two weeks.</p>}
      {days.map(([date, times]) => {
        const selected = times.find((t) => t.start === open);
        return (
          <div class="day-times" key={date} data-day={date}>
            <h3>{dayText(view, times[0]?.start ?? 0)}</h3>
            <div class="actions">
              {times.map((t) => (
                <button
                  type="button"
                  key={t.start}
                  data-start={t.start}
                  data-offered={t.offered ? "1" : "0"}
                  class={t.offered ? (t.preferred ? "preferred" : "") : "not-offered"}
                  aria-expanded={open === t.start}
                  onClick={() => setOpen(open === t.start ? null : t.start)}
                >
                  {timeText(view, t.start)}
                  {t.failures.map((f, i) => (
                    <span
                      key={`${f.code}-${i}`}
                      class={`dot dot-${COLOR[f.code]}`}
                      data-reason={f.code}
                      title={explain(f)}
                    />
                  ))}
                </button>
              ))}
            </div>
            {selected && (
              <ul class="inspect-details" data-testid="inspect-details">
                {selected.offered && <li>Offered to bookers.</li>}
                {selected.failures.map((f, i) => (
                  <li key={`${f.code}-${i}`} data-reason={f.code} data-person={f.person?.email}>
                    <span class={`dot dot-${COLOR[f.code]}`} /> {explain(f)}{" "}
                    {f.settings.map((s) => (
                      <a href={s.href} key={s.label}>
                        {s.label}
                      </a>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div class="actions">
        {from > first && (
          <button type="button" onClick={() => setFrom(Math.max(first, addPages(view, from, -1)))}>
            Earlier
          </button>
        )}
        {addPages(view, from, 1) < data.until && (
          <button type="button" onClick={() => setFrom(addPages(view, from, 1))}>
            Later
          </button>
        )}
      </div>
    </div>
  );
}
