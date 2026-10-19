// A holiday feed: an iCalendar file at a URL that Tempoloom reads and never
// writes (docs/specs/events-out-of-office.md rule 11). Its days block time like
// time away, also when the feed marks them free: the user added the feed to
// keep work off those days.
import ICAL from "ical.js";
import { eventsFromObject } from "./caldav.ts";
import {
  type CalendarProvider,
  type EventChanges,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
} from "./types.ts";

/** The feed is read again at most this often; "Refresh calendar list" reads it at once. */
const REFRESH_MS = 6 * 3_600_000;
const MAX_BYTES = 2_000_000;

/** Fetches a feed; webcal:// is the https URL of the same feed. */
export async function fetchFeed(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url.replace(/^webcal:/i, "https:"), {
      headers: { accept: "text/calendar" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ProviderError("other", 0, `Feed unreachable: ${String(err)}`);
  }
  if (!res.ok) throw new ProviderError("other", res.status, `Feed answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new ProviderError("other", 413, "Feed too large");
  if (!/BEGIN:VCALENDAR/i.test(text))
    throw new ProviderError("other", 415, "Not an iCalendar feed");
  return text;
}

/** The feed's name (X-WR-CALNAME), or its address. */
export function feedName(text: string, url: string): string {
  const name = /^X-WR-CALNAME:(.+)$/im.exec(text)?.[1]?.trim();
  return name || new URL(url.replace(/^webcal:/i, "https:")).host;
}

/** Events of a feed in [from, to), recurring ones expanded; all of them busy. */
export function feedEvents(
  text: string,
  url: string,
  from: number,
  to: number,
  zone: string,
): ProviderEvent[] {
  const root = new ICAL.Component(ICAL.parse(text));
  const zones = root.getAllSubcomponents("vtimezone").map((z) => z.toJSON());
  const byUid = new Map<string, ICAL.Component[]>();
  root.getAllSubcomponents("vevent").forEach((v, i) => {
    const uid = String(v.getFirstPropertyValue("uid") ?? `event-${i}`);
    byUid.set(uid, [...(byUid.get(uid) ?? []), v]);
  });
  const out: ProviderEvent[] = [];
  for (const [uid, parts] of byUid) {
    const cal = new ICAL.Component(["vcalendar", [], []]);
    for (const z of zones) cal.addSubcomponent(new ICAL.Component(z));
    for (const p of parts) cal.addSubcomponent(new ICAL.Component(p.toJSON()));
    const id = `${url}#${encodeURIComponent(uid)}`;
    for (const e of eventsFromObject(cal.toString(), id, null, from, to, zone, ""))
      out.push({ ...e, busy: true, attendeeCount: 0, attendees: [], selfResponse: null });
  }
  return out;
}

export class IcsFeedProvider implements CalendarProvider {
  readonly #url: string;
  readonly #zone: string;
  readonly #now: () => number;

  constructor(url: string, zone: string, now: () => number = Date.now) {
    this.#url = url;
    this.#zone = zone;
    this.#now = now;
  }

  async listCalendars(): Promise<ProviderCalendar[]> {
    const text = await fetchFeed(this.#url);
    return [
      {
        id: this.#url,
        name: feedName(text, this.#url),
        primary: false,
        writable: false,
        timeZone: null,
        color: null,
      },
    ];
  }

  /** The sync token is the time of the last read. */
  async listEvents(
    _calendarId: string,
    opts: { syncToken: string | null; timeMin: number; timeMax: number },
  ): Promise<EventChanges> {
    const now = this.#now();
    if (opts.syncToken && now - Number(opts.syncToken) < REFRESH_MS)
      return { events: [], nextSyncToken: opts.syncToken, full: false };
    const text = await fetchFeed(this.#url);
    return {
      events: feedEvents(text, this.#url, opts.timeMin, opts.timeMax, this.#zone),
      nextSyncToken: String(now),
      full: true,
    };
  }

  #readOnly(): never {
    throw new ProviderError("other", 405, "A holiday feed is read-only");
  }
  insertEvent = async () => this.#readOnly();
  updateEvent = async () => this.#readOnly();
  deleteEvent = async () => this.#readOnly();
  setColor = async () => this.#readOnly();
  editExternal = async () => this.#readOnly();
}
