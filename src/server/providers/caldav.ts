// CalDAV backend (RFC 4791), for example Radicale, Nextcloud or Fastmail.
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { type DAVCalendar, DAVClient } from "tsdav";
import { isValidTimeZone, localToUtc } from "../../shared/time.ts";
import {
  type CalendarProvider,
  type EventChanges,
  type EventWrite,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
  type ResponseStatus,
} from "./types.ts";

export interface CalDavCredentials {
  serverUrl: string;
  username: string;
  password: string;
  /** The user's email, used to find the user among attendees. */
  email: string;
  /**
   * Another person's calendar home, read with an organization grant's account
   * (docs/specs/admin-sso-provisioning.md rule 12). Its calendars are read-only.
   */
  homeUrl?: string;
}

const PROPS_PROPERTY = "x-tempoloom-props";
const MAX_OCCURRENCES = 5000;

function davName(c: DAVCalendar): string {
  return typeof c.displayName === "string" && c.displayName ? c.displayName : c.url;
}

/** Converts an iCalendar time to an instant, using the IANA zone when the TZID names one. */
function instantOf(t: ICAL.Time, fallbackZone: string): number {
  const date = `${String(t.year).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  if (t.isDate) return localToUtc(fallbackZone, date, 0);
  const tzid = t.zone?.tzid;
  if (tzid === "UTC" || tzid === "Z") {
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  }
  const minutes = t.hour * 60 + t.minute;
  if (tzid && tzid !== "floating" && isValidTimeZone(tzid)) {
    return localToUtc(tzid, date, minutes) + t.second * 1000;
  }
  if (tzid && tzid !== "floating" && t.zone) return t.toUnixTime() * 1000;
  return localToUtc(fallbackZone, date, minutes) + t.second * 1000;
}

function readProps(ev: ICAL.Component): Record<string, string> {
  const raw = ev.getFirstPropertyValue(PROPS_PROPERTY);
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Runs a read-only request again after a server error (5xx), up to 3 tries.
 * Some servers answer 500 to a read that races with a delete of one event.
 */
export async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      const serverError = err instanceof Error && /\b5\d\d\b/.test(err.message);
      if (!serverError || attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}

/**
 * Google's 11 event colors as CSS color names, for the CalDAV COLOR property
 * (RFC 7986). Tempoloom keeps one color id for both backends.
 */
export const COLOR_NAMES: Record<string, string> = {
  "1": "mediumpurple",
  "2": "mediumseagreen",
  "3": "darkorchid",
  "4": "salmon",
  "5": "gold",
  "6": "orangered",
  "7": "deepskyblue",
  "8": "dimgray",
  "9": "royalblue",
  "10": "forestgreen",
  "11": "red",
};
const COLOR_IDS = new Map(Object.entries(COLOR_NAMES).map(([id, name]) => [name, id]));

/** A CalDAV time-range value: UTC, basic format. */
const davTime = (t: number) => `${new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;

/** Text of a parsed DAV property (plain, CDATA or text node). */
function davText(v: unknown): string | null {
  if (typeof v === "string") return v;
  const node = v as { _cdata?: unknown; _text?: unknown } | undefined;
  const t = node?._cdata ?? node?._text;
  return typeof t === "string" ? t : null;
}

const mailto = (v: unknown) =>
  typeof v === "string" ? v.replace(/^mailto:/i, "").toLowerCase() : "";

function attendeeFacts(ev: ICAL.Component, selfEmail: string) {
  const self = selfEmail.toLowerCase();
  const attendees = ev.getAllProperties("attendee");
  let selfResponse: ResponseStatus | null = null;
  for (const a of attendees) {
    if (mailto(a.getFirstValue()) !== self) continue;
    const partstat = String(a.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase();
    selfResponse =
      partstat === "ACCEPTED"
        ? "accepted"
        : partstat === "DECLINED"
          ? "declined"
          : partstat === "TENTATIVE"
            ? "tentative"
            : "needsAction";
  }
  const organizer = ev.getFirstPropertyValue("organizer");
  return {
    selfResponse,
    attendeeCount: attendees.length,
    attendees: attendees.map((a) => mailto(a.getFirstValue())).filter(Boolean),
    organizerSelf: organizer === null || organizer === undefined || mailto(organizer) === self,
  };
}

function baseEvent(
  comp: ICAL.Component,
  id: string,
  etag: string | null,
  selfEmail: string,
): Omit<ProviderEvent, "start" | "end" | "allDay"> {
  const str = (name: string) => {
    const v = comp.getFirstPropertyValue(name);
    return typeof v === "string" ? v : "";
  };
  const stamp =
    comp.getFirstPropertyValue("last-modified") ?? comp.getFirstPropertyValue("dtstamp");
  // CalDAV has no event type for time away; Outlook-style clients mark it with
  // this property, and Tempoloom reads it as Google's out-of-office type.
  const away = str("x-microsoft-cdo-busystatus").toUpperCase() === "OOF";
  return {
    id,
    cancelled: str("status").toUpperCase() === "CANCELLED",
    etag,
    summary: str("summary"),
    description: str("description"),
    location: str("location"),
    busy: away || str("transp").toUpperCase() !== "TRANSPARENT",
    eventType: away ? "outOfOffice" : "default",
    ...attendeeFacts(comp, selfEmail),
    recurringId: null,
    colorId: COLOR_IDS.get(str("color").toLowerCase()) ?? null,
    updated: stamp instanceof ICAL.Time ? stamp.toUnixTime() * 1000 : null,
    privateProps: readProps(comp),
  };
}

/** Parses one calendar object and expands recurring series inside [from, to). */
export function eventsFromObject(
  data: string,
  url: string,
  etag: string | null,
  from: number,
  to: number,
  zone: string,
  selfEmail: string,
): ProviderEvent[] {
  const root = new ICAL.Component(ICAL.parse(data));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  }
  const vevents = root.getAllSubcomponents("vevent");
  const master = vevents.find((v) => !v.hasProperty("recurrence-id"));
  const out: ProviderEvent[] = [];
  if (!master) return out;
  const event = new ICAL.Event(master);
  for (const ex of vevents) if (ex !== master) event.relateException(ex);

  if (!event.isRecurring()) {
    const start = instantOf(event.startDate, zone);
    const end = event.endDate ? instantOf(event.endDate, zone) : start;
    if (end > from && start < to) {
      out.push({
        ...baseEvent(master, url, etag, selfEmail),
        start,
        end,
        allDay: event.startDate.isDate,
      });
    }
    return out;
  }

  const it = event.iterator();
  for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
    const details = event.getOccurrenceDetails(next);
    const start = instantOf(details.startDate, zone);
    if (start >= to) break;
    const end = instantOf(details.endDate, zone);
    if (end <= from) continue;
    const comp = details.item.component;
    out.push({
      ...baseEvent(comp, `${url}#${details.recurrenceId.toString()}`, etag, selfEmail),
      recurringId: url,
      start,
      end,
      allDay: details.startDate.isDate,
    });
  }
  return out;
}

function toUtcTime(ms: number): ICAL.Time {
  const d = new Date(ms);
  return ICAL.Time.fromData(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      isDate: false,
    },
    ICAL.Timezone.utcTimezone,
  );
}

export function objectFromWrite(uid: string, w: EventWrite, now: number): string {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("prodid", "-//Tempoloom//EN");
  const ev = new ICAL.Component("vevent");
  ev.addPropertyWithValue("uid", uid);
  ev.addPropertyWithValue("dtstamp", toUtcTime(now));
  ev.addPropertyWithValue("last-modified", toUtcTime(now));
  if (w.allDayDates) {
    ev.addPropertyWithValue("dtstart", ICAL.Time.fromDateString(w.allDayDates.start));
    ev.addPropertyWithValue("dtend", ICAL.Time.fromDateString(w.allDayDates.end));
  } else {
    ev.addPropertyWithValue("dtstart", toUtcTime(w.start));
    ev.addPropertyWithValue("dtend", toUtcTime(w.end));
  }
  ev.addPropertyWithValue("summary", w.summary);
  if (w.description) ev.addPropertyWithValue("description", w.description);
  if (w.location) ev.addPropertyWithValue("location", w.location);
  ev.addPropertyWithValue("transp", w.busy ? "OPAQUE" : "TRANSPARENT");
  if (w.colorId && COLOR_NAMES[w.colorId]) ev.addPropertyWithValue("color", COLOR_NAMES[w.colorId]);
  if (w.organizer) ev.addPropertyWithValue("organizer", `mailto:${w.organizer}`);
  for (const email of w.attendees ?? []) ev.addPropertyWithValue("attendee", `mailto:${email}`);
  for (const email of w.optionalAttendees ?? []) {
    const p = ev.addPropertyWithValue("attendee", `mailto:${email}`);
    p.setParameter("role", "OPT-PARTICIPANT");
  }
  ev.addPropertyWithValue(
    PROPS_PROPERTY,
    Buffer.from(JSON.stringify(w.privateProps)).toString("base64url"),
  );
  cal.addSubcomponent(ev);
  return cal.toString();
}

export class CalDavProvider implements CalendarProvider {
  readonly #creds: CalDavCredentials;
  readonly #zone: string;
  readonly #now: () => number;
  #client: Promise<DAVClient> | undefined;
  #calendars = new Map<string, DAVCalendar>();

  constructor(creds: CalDavCredentials, zone: string, now: () => number = Date.now) {
    this.#creds = creds;
    this.#zone = zone;
    this.#now = now;
  }

  #connect(): Promise<DAVClient> {
    this.#client ??= (async () => {
      const client = new DAVClient({
        serverUrl: this.#creds.serverUrl,
        credentials: { username: this.#creds.username, password: this.#creds.password },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
      try {
        await client.login();
      } catch (err) {
        this.#client = undefined;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ProviderError(
          /401|unauthori[sz]ed|invalid credentials/i.test(msg) ? "auth" : "other",
          0,
          msg,
        );
      }
      return client;
    })();
    return this.#client;
  }

  async #fetchCalendars(): Promise<DAVCalendar[]> {
    const client = await this.#connect();
    const home = this.#creds.homeUrl;
    const account = home && client.account ? { ...client.account, homeUrl: home } : undefined;
    const cals = (
      await retryRead(() => client.fetchCalendars(account ? { account } : undefined))
    ).filter((c) => !c.components || c.components.includes("VEVENT"));
    this.#calendars = new Map(cals.map((c) => [c.url, c]));
    return cals;
  }

  async #calendar(id: string): Promise<DAVCalendar> {
    const cached = this.#calendars.get(id);
    if (cached) return cached;
    const found = (await this.#fetchCalendars()).find((c) => c.url === id);
    if (!found) throw new ProviderError("not_found", 404, `Calendar ${id} not found`);
    return found;
  }

  async listCalendars(): Promise<ProviderCalendar[]> {
    const cals = (await this.#fetchCalendars()).sort((a, b) => a.url.localeCompare(b.url));
    return cals.map((c, i) => ({
      id: c.url,
      name: davName(c),
      primary: i === 0,
      writable: this.#creds.homeUrl === undefined,
      timeZone: null,
      color: c.calendarColor ?? null,
    }));
  }

  async listEvents(
    calendarId: string,
    opts: { syncToken: string | null; timeMin: number; timeMax: number },
  ): Promise<EventChanges> {
    const client = await this.#connect();
    await this.#fetchCalendars();
    const cal = await this.#calendar(calendarId);
    const tag = cal.ctag ?? cal.syncToken ?? null;
    if (opts.syncToken && tag && opts.syncToken === tag) {
      return { events: [], nextSyncToken: tag, full: false };
    }
    // One calendar-query that returns the data. Two requests (a query, then a
    // fetch of what it found) fail when an event is deleted between them.
    const objects = (
      await retryRead(() =>
        client.calendarQuery({
          url: cal.url,
          props: { "d:getetag": {}, "c:calendar-data": {} },
          filters: [
            {
              "comp-filter": {
                _attributes: { name: "VCALENDAR" },
                "comp-filter": {
                  _attributes: { name: "VEVENT" },
                  "time-range": {
                    _attributes: { start: davTime(opts.timeMin), end: davTime(opts.timeMax) },
                  },
                },
              },
            },
          ],
          depth: "1",
        }),
      )
    ).map((r) => ({
      url: new URL(r.href ?? "", cal.url).toString(),
      etag: davText(r.props?.getetag),
      data: davText(r.props?.calendarData),
    }));
    const events: ProviderEvent[] = [];
    for (const o of objects) {
      if (typeof o.data !== "string" || !o.data) continue;
      events.push(
        ...eventsFromObject(
          o.data,
          o.url,
          o.etag ?? null,
          opts.timeMin,
          opts.timeMax,
          this.#zone,
          this.#creds.email,
        ),
      );
    }
    return { events, nextSyncToken: tag, full: true };
  }

  async #readBack(url: string, fallback: EventWrite, etag: string | null): Promise<ProviderEvent> {
    const client = await this.#connect();
    const cal = this.#calendars.get(url.slice(0, url.lastIndexOf("/") + 1));
    const objs = cal
      ? await retryRead(() => client.fetchCalendarObjects({ calendar: cal, objectUrls: [url] }))
      : [];
    const obj = objs.find((o) => o.url === url) ?? objs[0];
    const data = typeof obj?.data === "string" ? obj.data : undefined;
    if (data) {
      const [ev] = eventsFromObject(
        data,
        url,
        obj?.etag ?? etag,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        this.#zone,
        this.#creds.email,
      );
      if (ev) return ev;
    }
    return {
      id: url,
      cancelled: false,
      etag,
      summary: fallback.summary,
      description: fallback.description,
      location: fallback.location ?? "",
      start: fallback.start,
      end: fallback.end,
      allDay: false,
      busy: fallback.busy,
      eventType: "default",
      selfResponse: null,
      attendeeCount: fallback.attendees?.length ?? 0,
      attendees: [...(fallback.attendees ?? []), ...(fallback.optionalAttendees ?? [])],
      organizerSelf: true,
      recurringId: null,
      colorId: fallback.colorId,
      updated: this.#now(),
      privateProps: fallback.privateProps,
    };
  }

  async insertEvent(calendarId: string, event: EventWrite): Promise<ProviderEvent> {
    const client = await this.#connect();
    const cal = await this.#calendar(calendarId);
    const uid = randomUUID();
    const res = await client.createCalendarObject({
      calendar: cal,
      filename: `${uid}.ics`,
      iCalString: objectFromWrite(uid, event, this.#now()),
    });
    if (!res.ok) throw new ProviderError("other", res.status, `Create failed: ${res.status}`);
    const url = new URL(`${uid}.ics`, cal.url).toString();
    return this.#readBack(url, event, res.headers.get("etag"));
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: EventWrite,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const client = await this.#connect();
    await this.#calendar(calendarId);
    const uid = decodeURIComponent(eventId.slice(eventId.lastIndexOf("/") + 1)).replace(
      /\.ics$/,
      "",
    );
    const res = await client.updateCalendarObject({
      calendarObject: {
        url: eventId,
        data: objectFromWrite(uid, event, this.#now()),
        ...(etag ? { etag } : {}),
      },
    });
    if (res.status === 412) throw new ProviderError("precondition_failed", 412, "Event changed");
    if (res.status === 404) throw new ProviderError("not_found", 404, "Event not found");
    if (!res.ok) throw new ProviderError("other", res.status, `Update failed: ${res.status}`);
    return this.#readBack(eventId, event, res.headers.get("etag"));
  }

  async setColor(
    calendarId: string,
    eventId: string,
    colorId: string | null,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const client = await this.#connect();
    const cal = await this.#calendar(calendarId);
    const [obj] = await retryRead(() =>
      client.fetchCalendarObjects({ calendar: cal, objectUrls: [eventId] }),
    );
    if (typeof obj?.data !== "string") throw new ProviderError("not_found", 404, "Event not found");
    const root = new ICAL.Component(ICAL.parse(obj.data));
    const name = colorId ? COLOR_NAMES[colorId] : undefined;
    for (const ev of root.getAllSubcomponents("vevent")) {
      ev.removeAllProperties("color");
      if (name) ev.addPropertyWithValue("color", name);
    }
    const match = obj.etag ?? etag;
    const res = await client.updateCalendarObject({
      calendarObject: { url: eventId, data: root.toString(), ...(match ? { etag: match } : {}) },
    });
    if (res.status === 412) throw new ProviderError("precondition_failed", 412, "Event changed");
    if (res.status === 404) throw new ProviderError("not_found", 404, "Event not found");
    if (!res.ok) throw new ProviderError("other", res.status, `Update failed: ${res.status}`);
    const [first] = root.getAllSubcomponents("vevent");
    const read = (p: string) => String(first?.getFirstPropertyValue(p) ?? "");
    return this.#readBack(
      eventId,
      {
        summary: read("summary"),
        description: read("description"),
        start: 0,
        end: 0,
        busy: read("transp").toUpperCase() !== "TRANSPARENT",
        colorId,
        privateProps: first ? readProps(first) : {},
      },
      res.headers.get("etag"),
    );
  }

  /**
   * This account's access to a calendar collection, from the server's
   * DAV:current-user-privilege-set (RFC 3744): write, read only, or none.
   */
  async accessTo(calendarUrl: string): Promise<"write" | "read" | "none"> {
    const res = await fetch(calendarUrl, {
      method: "PROPFIND",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.#creds.username}:${this.#creds.password}`).toString("base64")}`,
        depth: "0",
        "content-type": "application/xml; charset=utf-8",
      },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-privilege-set/></d:prop></d:propfind>',
    });
    if (res.status === 401) throw new ProviderError("auth", 401, "CalDAV credentials rejected");
    if (res.status !== 207) return "none";
    const set =
      /current-user-privilege-set[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?current-user-privilege-set/i.exec(
        await res.text(),
      )?.[1];
    if (!set) return "none";
    const has = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\s*/?>`, "i").test(set);
    if (has("all") || has("write") || has("write-content") || has("bind")) return "write";
    return has("read") ? "read" : "none";
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const client = await this.#connect();
    await this.#calendar(calendarId);
    const res = await client.deleteCalendarObject({ calendarObject: { url: eventId } });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new ProviderError("other", res.status, `Delete failed: ${res.status}`);
    }
  }
}
