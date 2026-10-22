// CalDAV backend (RFC 4791), for example Radicale, Nextcloud or Fastmail.
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { type DAVCalendar, DAVClient } from "tsdav";
import { isValidTimeZone, localToUtc, utcToLocal } from "../../shared/time.ts";
import {
  type CalendarProvider,
  type EventChanges,
  type EventWrite,
  type ExternalChange,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
  type ResponseStatus,
  type SeriesFacts,
} from "./types.ts";
import { vtimezone } from "./vtimezone.ts";

export interface CalDavCredentials {
  serverUrl: string;
  username: string;
  password: string;
  /**
   * The user's email. With the principal's calendar-user-address-set
   * (RFC 6638), it finds the user among attendees.
   */
  email: string;
  /**
   * Another person's calendar home, read with an organization grant's account
   * (docs/specs/admin-sso-provisioning.md rule 12). Its calendars are read-only.
   */
  homeUrl?: string;
  /**
   * Calendars that other people shared with this account, by URL
   * (docs/specs/accounts-connected-calendars.md rule 30).
   */
  sharedUrls?: string[];
}

const PROPS_PROPERTY = "x-tempoloom-props";
/**
 * CalDAV servers keep no default reminders, so "the calendar default" is one
 * alert this many minutes before the start: Google's own default (NTF-10).
 */
export const DEFAULT_REMINDER_MINUTES = 10;
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

function responseOf(a: ICAL.Property): ResponseStatus {
  const partstat = String(a.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase();
  return partstat === "ACCEPTED"
    ? "accepted"
    : partstat === "DECLINED"
      ? "declined"
      : partstat === "TENTATIVE"
        ? "tentative"
        : "needsAction";
}

/**
 * The user's addresses, lower case, without `mailto:`. The first one is the
 * account's own address.
 */
interface Self {
  primary: string;
  all: ReadonlySet<string>;
}
const selfOf = (addresses: readonly string[]): Self => {
  const all = addresses.map(mailto).filter(Boolean);
  return { primary: all[0] ?? "", all: new Set(all) };
};

/**
 * The user's own attendee line: the line of the account's address, else the
 * first line of another address of the user.
 */
function selfLine(ev: ICAL.Component, self: Self): ICAL.Property | undefined {
  const lines = ev.getAllProperties("attendee");
  const own = self.primary
    ? lines.find((a) => mailto(a.getFirstValue()) === self.primary)
    : undefined;
  if (own) return own;
  return lines.find((a) => self.all.has(mailto(a.getFirstValue())));
}

function attendeeFacts(ev: ICAL.Component, self: Self) {
  const attendees = ev.getAllProperties("attendee");
  const responses: Record<string, ResponseStatus> = {};
  for (const a of attendees) {
    const email = mailto(a.getFirstValue());
    if (email) responses[email] = responseOf(a);
  }
  const own = selfLine(ev, self);
  const organizer = ev.getFirstPropertyValue("organizer");
  // The user's RSVP note (events-tags.md) is the X-RESPONSE-COMMENT of the
  // user's own attendee line. A COMMENT on the event is the organizer's text
  // (edge case 5: someone else's note is ignored).
  const organizerSelf =
    organizer === null || organizer === undefined || self.all.has(mailto(organizer));
  return {
    selfResponse: own ? responseOf(own) : null,
    rsvpNote: own ? String(own.getParameter("x-response-comment") ?? "") : "",
    responses,
    attendeeCount: attendees.length,
    attendees: attendees.map((a) => mailto(a.getFirstValue())).filter(Boolean),
    organizerSelf,
    organizerEmail: mailto(organizer),
  };
}

const CLASSES: Record<string, ProviderEvent["visibility"]> = {
  PUBLIC: "public",
  PRIVATE: "private",
  CONFIDENTIAL: "confidential",
};

function baseEvent(
  comp: ICAL.Component,
  id: string,
  etag: string | null,
  self: Self,
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
    ...attendeeFacts(comp, self),
    recurringId: null,
    colorId: COLOR_IDS.get(str("color").toLowerCase()) ?? null,
    updated: stamp instanceof ICAL.Time ? stamp.toUnixTime() * 1000 : null,
    privateProps: readProps(comp),
    // RFC 7986 CONFERENCE: a video call link (automations-meeting-quality.md, video_link).
    conference: str("conference"),
    alerts: comp.getAllSubcomponents("valarm").length > 0,
    visibility: CLASSES[str("class").toUpperCase()] ?? "default",
  };
}

const PROPFIND_ADDRESSES =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-user-address-set/></d:prop></d:propfind>';

/** The `mailto:` addresses in a calendar-user-address-set (RFC 6638 2.4.1), lower case. */
export function addressesIn(xml: string): string[] {
  const set =
    /calendar-user-address-set[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-user-address-set/i.exec(
      xml,
    )?.[1] ?? "";
  return [...set.matchAll(/<(?:[\w-]+:)?href[^>]*>\s*([^<]*?)\s*</gi)]
    .map((m) => m[1] ?? "")
    .filter((h) => /^mailto:/i.test(h))
    .map(mailto);
}

/** The user's addresses of each CalDAV account, read once (server and user name as key). */
const addressCache = new Map<string, Promise<string[]>>();

/** Forgets every cached address set (tests). */
export function forgetAddresses(): void {
  addressCache.clear();
}

const PROPFIND_ACCESS =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><d:resourcetype/><d:current-user-privilege-set/><d:sync-token/><cs:getctag/></d:prop></d:propfind>';

/** Access in a DAV:current-user-privilege-set (RFC 3744), or null when the server gives none. */
function accessIn(xml: string): "write" | "read" | "none" | null {
  const set =
    /current-user-privilege-set[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?current-user-privilege-set/i.exec(
      xml,
    )?.[1];
  if (set === undefined) return null;
  const has = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\s*/?>`, "i").test(set);
  if (has("all") || has("write") || has("write-content") || has("bind")) return "write";
  return has("read") ? "read" : "none";
}

/** Text of one property in a PROPFIND response. */
const propText = (xml: string, name: string) =>
  new RegExp(`<(?:[\\w-]+:)?${name}[^>/]*>([^<]*)<`, "i").exec(xml)?.[1]?.trim() ?? null;

/** The responses of a multistatus body, by absolute URL. */
function responses(xml: string, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of xml.split(/<(?:[\w-]+:)?response[\s>]/i).slice(1)) {
    const href = propText(part, "href");
    if (href) out.set(new URL(href, base).toString(), part);
  }
  return out;
}

/** Parses one calendar object and expands recurring series inside [from, to). */
export function eventsFromObject(
  data: string,
  url: string,
  etag: string | null,
  from: number,
  to: number,
  zone: string,
  /** The user's addresses, the account's own first (`mailto:` forms allowed, any case). */
  selfAddresses: readonly string[],
): ProviderEvent[] {
  const self = selfOf(selfAddresses);
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
        ...baseEvent(master, url, etag, self),
        start,
        end,
        allDay: event.startDate.isDate,
      });
    }
    return out;
  }

  const facts = seriesFacts(master, event, zone);
  const it = event.iterator();
  for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
    const details = event.getOccurrenceDetails(next);
    const start = instantOf(details.startDate, zone);
    if (start >= to) break;
    const end = instantOf(details.endDate, zone);
    if (end <= from) continue;
    const comp = details.item.component;
    out.push({
      ...baseEvent(comp, `${url}#${details.recurrenceId.toString()}`, etag, self),
      recurringId: url,
      start,
      end,
      allDay: details.startDate.isDate,
      series: { ...facts, own: comp !== master },
    });
  }
  return out;
}

/** What the master of a series says (types.ts SeriesFacts), for each of its instances. */
function seriesFacts(master: ICAL.Component, event: ICAL.Event, zone: string): SeriesFacts {
  const start = instantOf(event.startDate, zone);
  const guests = master.getAllProperties("attendee");
  const optional = (a: ICAL.Property) =>
    String(a.getParameter("role") ?? "").toUpperCase() === "OPT-PARTICIPANT";
  return {
    start,
    end: event.endDate ? instantOf(event.endDate, zone) : start,
    rrule: String(master.getFirstPropertyValue("rrule") ?? ""),
    summary: String(master.getFirstPropertyValue("summary") ?? ""),
    attendees: guests.filter((a) => !optional(a)).map((a) => mailto(a.getFirstValue())),
    optional: guests.filter(optional).map((a) => mailto(a.getFirstValue())),
    own: false,
  };
}

/** A local time of `zone` (no zone of its own: the caller sets the TZID parameter). */
function localTime(zone: string, ms: number): ICAL.Time {
  const l = utcToLocal(zone, ms);
  const [year, month, day] = l.date.split("-").map(Number) as [number, number, number];
  return ICAL.Time.fromData({
    year,
    month,
    day,
    hour: Math.floor(l.minuteOfDay / 60),
    minute: l.minuteOfDay % 60,
    second: 0,
    isDate: false,
  });
}

/** Adds a date-time property: local with a TZID when `zone` is set, else UTC. */
function addTime(ev: ICAL.Component, name: string, ms: number, zone: string | undefined) {
  if (!zone) return ev.addPropertyWithValue(name, toUtcTime(ms));
  const p = new ICAL.Property(name);
  p.setValue(localTime(zone, ms));
  p.setParameter("tzid", zone);
  ev.addProperty(p);
  return p;
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

/** Adds the VALARMs of `reminders` to an event; none when missing. */
function addAlarms(ev: ICAL.Component, reminders: EventWrite["reminders"], summary: string) {
  const alerts = !reminders
    ? []
    : "useDefault" in reminders
      ? [DEFAULT_REMINDER_MINUTES]
      : reminders.minutes;
  for (const minutes of alerts) {
    const alarm = new ICAL.Component("valarm");
    alarm.addPropertyWithValue("action", "DISPLAY");
    alarm.addPropertyWithValue("description", summary);
    alarm.addPropertyWithValue("trigger", ICAL.Duration.fromSeconds(-minutes * 60));
    ev.addSubcomponent(alarm);
  }
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
    // A series keeps its local time across DST changes (TZID and VTIMEZONE).
    const zone = w.recurrence && w.timeZone && isValidTimeZone(w.timeZone) ? w.timeZone : undefined;
    if (zone)
      cal.addSubcomponent(
        new ICAL.Component(ICAL.parse(vtimezone(zone, new Date(w.start).getUTCFullYear()))),
      );
    addTime(ev, "dtstart", w.start, zone);
    addTime(ev, "dtend", w.end, zone);
    for (const t of w.exdates ?? []) addTime(ev, "exdate", t, zone);
  }
  if (w.recurrence) ev.addPropertyWithValue("rrule", ICAL.Recur.fromString(w.recurrence));
  ev.addPropertyWithValue("summary", w.summary);
  if (w.description) ev.addPropertyWithValue("description", w.description);
  if (w.location) ev.addPropertyWithValue("location", w.location);
  ev.addPropertyWithValue("transp", w.busy ? "OPAQUE" : "TRANSPARENT");
  if (w.colorId && COLOR_NAMES[w.colorId]) ev.addPropertyWithValue("color", COLOR_NAMES[w.colorId]);
  if (w.visibility === "public" || w.visibility === "private") {
    ev.addPropertyWithValue("class", w.visibility.toUpperCase());
  }
  addAlarms(ev, w.reminders, w.summary);
  if (w.organizer) ev.addPropertyWithValue("organizer", `mailto:${w.organizer}`);
  for (const email of w.attendees ?? []) {
    const p = ev.addPropertyWithValue("attendee", `mailto:${email}`);
    if (w.quietGuests) p.setParameter("schedule-agent", "CLIENT");
  }
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

/** A series object, with the instance an id names (`<object url>#<recurrence id>`). */
interface Series {
  client: DAVClient;
  url: string;
  etag: string | null;
  root: ICAL.Component;
  master: ICAL.Component;
  occurrence: ICAL.Time;
  override: ICAL.Component | undefined;
}

export class CalDavProvider implements CalendarProvider {
  readonly #creds: CalDavCredentials;
  readonly #zone: string;
  readonly #now: () => number;
  #client: Promise<DAVClient> | undefined;
  #calendars = new Map<string, DAVCalendar>();
  /** Write access of each listed calendar, when the server reports it. */
  #access = new Map<string, "write" | "read" | "none">();
  /** Whether the server mails guests (calendar-auto-schedule), kept once definite. */
  #scheduling: Promise<boolean> | undefined;

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

  /**
   * The user's addresses: the account email and the principal's
   * calendar-user-address-set, read once per account. A grant reads another
   * person's home with its own principal, so it keeps the email alone.
   */
  async #self(): Promise<string[]> {
    const email = this.#creds.email.toLowerCase();
    if (this.#creds.homeUrl !== undefined) return [email];
    const key = `${this.#creds.serverUrl}\n${this.#creds.username}`;
    let found = addressCache.get(key);
    if (!found) {
      found = (async () => {
        const principal = (await this.#connect()).account?.principalUrl;
        if (!principal) return [];
        const res = await this.#propfind(principal, "0", PROPFIND_ADDRESSES);
        if (res.status >= 500)
          throw new ProviderError("other", res.status, `PROPFIND ${res.status}`);
        return res.status === 207 ? addressesIn(await res.text()) : [];
      })();
      addressCache.set(key, found);
      // A failed read is tried again on the next call.
      found.catch(() => addressCache.delete(key));
    }
    try {
      return [...new Set([email, ...(await found)])];
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") throw err;
      return [email];
    }
  }

  async #fetchCalendars(): Promise<DAVCalendar[]> {
    const client = await this.#connect();
    const home = this.#creds.homeUrl;
    const account = home && client.account ? { ...client.account, homeUrl: home } : undefined;
    const cals = (
      await retryRead(() => client.fetchCalendars(account ? { account } : undefined))
    ).filter((c) => !c.components || c.components.includes("VEVENT"));
    this.#access = new Map();
    for (const url of this.#creds.sharedUrls ?? []) {
      if (cals.some((c) => c.url === url)) continue;
      // A share that is gone drops out; a network error fails the read, so nothing is lost.
      const shared = await this.describe(url);
      if (!shared || shared.access === "none") continue;
      this.#access.set(url, shared.access);
      cals.push({
        url,
        displayName: shared.name,
        ctag: shared.tag ?? undefined,
        components: ["VEVENT"],
      } as DAVCalendar);
    }
    this.#calendars = new Map(cals.map((c) => [c.url, c]));
    return cals;
  }

  async #propfind(url: string, depth: "0" | "1", body = PROPFIND_ACCESS): Promise<Response> {
    const res = await fetch(url, {
      method: "PROPFIND",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.#creds.username}:${this.#creds.password}`).toString("base64")}`,
        depth,
        "content-type": "application/xml; charset=utf-8",
      },
      body,
    });
    if (res.status === 401) throw new ProviderError("auth", 401, "CalDAV credentials rejected");
    return res;
  }

  /** Write access of the calendars in a calendar home, from one request. */
  async #accessUnder(home: string): Promise<Map<string, "write" | "read" | "none">> {
    const out = new Map<string, "write" | "read" | "none">();
    try {
      const res = await this.#propfind(home, "1");
      if (res.status !== 207) return out;
      for (const [url, part] of responses(await res.text(), home)) {
        const access = accessIn(part);
        if (access) out.set(url, access);
      }
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "auth") throw err;
    }
    return out;
  }

  /**
   * Name, change tag and this account's access of one calendar collection
   * (a calendar that someone shared by URL), or null when it is not a calendar.
   */
  async describe(
    url: string,
  ): Promise<{ name: string; tag: string | null; access: "write" | "read" | "none" } | null> {
    const res = await this.#propfind(url, "0");
    if (res.status >= 500) throw new ProviderError("other", res.status, `PROPFIND ${res.status}`);
    if (res.status !== 207) return null;
    const xml = await res.text();
    if (!/<(?:[\w-]+:)?calendar\s*\/>/i.test(xml)) return null;
    return {
      name: propText(xml, "displayname") || url,
      tag: propText(xml, "getctag") ?? propText(xml, "sync-token"),
      access: accessIn(xml) ?? "write",
    };
  }

  /**
   * One calendar object, as the server stores it. A missing object (404, 410)
   * is a ProviderError "not_found" for every caller: the CalDAV client throws a
   * plain Error for it.
   */
  async #object(cal: DAVCalendar, url: string): Promise<{ data: string; etag: string | null }> {
    const client = await this.#connect();
    const objs = await retryRead(() =>
      client.fetchCalendarObjects({ calendar: cal, objectUrls: [url] }),
    ).catch(async (err: unknown) => {
      // The client's error text may hold the server's answer body, so only the
      // HTTP status of a direct read decides that the object is gone.
      if ((await this.#statusOf(url)) === "gone")
        throw new ProviderError("not_found", 404, "Event not found");
      throw err;
    });
    const obj = objs.find((o) => o.url === url) ?? objs[0];
    if (typeof obj?.data !== "string") throw new ProviderError("not_found", 404, "Event not found");
    return { data: obj.data, etag: obj.etag ?? null };
  }

  /** "gone" when a GET of the object answers 404 or 410; anything else (or no answer) is "unknown". */
  async #statusOf(url: string): Promise<"gone" | "unknown"> {
    const res = await fetch(url, {
      headers: {
        authorization: `Basic ${Buffer.from(`${this.#creds.username}:${this.#creds.password}`).toString("base64")}`,
      },
    }).catch(() => null);
    await res?.body?.cancel().catch(() => undefined);
    return res && (res.status === 404 || res.status === 410) ? "gone" : "unknown";
  }

  async #calendar(id: string): Promise<DAVCalendar> {
    const cached = this.#calendars.get(id);
    if (cached) return cached;
    const found = (await this.#fetchCalendars()).find((c) => c.url === id);
    if (!found) throw new ProviderError("not_found", 404, `Calendar ${id} not found`, "calendar");
    return found;
  }

  async listCalendars(): Promise<ProviderCalendar[]> {
    const cals = (await this.#fetchCalendars()).sort((a, b) => a.url.localeCompare(b.url));
    const home = (await this.#connect()).account?.homeUrl;
    const own = home && !this.#creds.homeUrl ? await this.#accessUnder(home) : new Map();
    // The first calendar of the own home is the primary one; a shared calendar never is.
    const shared = new Set(this.#creds.sharedUrls ?? []);
    const primary = cals.find((c) => !shared.has(c.url));
    return cals.map((c) => ({
      id: c.url,
      name: davName(c),
      primary: c === primary,
      // A server that reports no privileges keeps today's rule: the own home is writable.
      writable:
        this.#creds.homeUrl === undefined &&
        (this.#access.get(c.url) ?? own.get(c.url) ?? "write") === "write",
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
    const self = await this.#self();
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
          self,
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
        await this.#self(),
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
      visibility: fallback.visibility ?? "default",
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
    if (eventId.includes("#")) return this.#updateInstance(calendarId, eventId, event, etag);
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
    const obj = await this.#object(cal, eventId);
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

  /**
   * A server that has calendar-auto-schedule in its DAV header (RFC 6638)
   * mails the guests on each change of an event with attendees. An error
   * answer or a network error counts as yes and is not kept, so a later call
   * asks again; only a definite answer is kept.
   */
  notifiesGuests(calendarId: string): Promise<boolean> {
    if (this.#scheduling) return this.#scheduling;
    const ask = fetch(calendarId, {
      method: "OPTIONS",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.#creds.username}:${this.#creds.password}`).toString("base64")}`,
      },
    }).then(
      (res) => {
        if (!res.ok) {
          this.#scheduling = undefined;
          return true;
        }
        return /\bcalendar-auto-schedule\b/i.test(res.headers.get("dav") ?? "");
      },
      () => {
        this.#scheduling = undefined;
        return true;
      },
    );
    this.#scheduling = ask;
    return ask;
  }

  async editExternal(
    calendarId: string,
    eventId: string,
    change: ExternalChange,
    etag: string | null,
  ): Promise<ProviderEvent> {
    if (eventId.includes("#")) return this.#editInstance(calendarId, eventId, change, etag);
    const client = await this.#connect();
    const cal = await this.#calendar(calendarId);
    const obj = await this.#object(cal, eventId);
    const root = new ICAL.Component(ICAL.parse(obj.data));
    const ev = root.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
    if (!ev) throw new ProviderError("not_found", 404, "Event not found");
    this.#apply(ev, change, await this.#self());
    const match = obj.etag ?? etag;
    const res = await client.updateCalendarObject({
      calendarObject: { url: eventId, data: root.toString(), ...(match ? { etag: match } : {}) },
    });
    if (res.status === 412) throw new ProviderError("precondition_failed", 412, "Event changed");
    if (res.status === 404) throw new ProviderError("not_found", 404, "Event not found");
    if (!res.ok) throw new ProviderError("other", res.status, `Update failed: ${res.status}`);
    const read = (p: string) => String(ev.getFirstPropertyValue(p) ?? "");
    return this.#readBack(
      eventId,
      {
        summary: read("summary"),
        description: read("description"),
        start: change.start ?? 0,
        end: change.end ?? 0,
        busy: read("transp").toUpperCase() !== "TRANSPARENT",
        colorId: null,
        privateProps: readProps(ev),
      },
      res.headers.get("etag"),
    );
  }

  /** Changes the given fields of one instance of a series, in its override. */
  async #editInstance(
    calendarId: string,
    eventId: string,
    change: ExternalChange,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const series = await this.#series(calendarId, eventId);
    const { start, end } = this.#instanceTimes(series);
    const ov = this.#override(series);
    this.#apply(ov, change, await this.#self());
    const tag = await this.#putSeries(series.url, series.root, series.etag ?? etag);
    const found = eventsFromObject(
      series.root.toString(),
      series.url,
      tag,
      Math.min(start, change.start ?? start) - 86_400_000,
      Math.max(end, change.end ?? end) + 86_400_000,
      this.#zone,
      await this.#self(),
    ).find((e) => e.id === eventId);
    if (!found) throw new ProviderError("other", 500, "Instance missing after update");
    return found;
  }

  /** Writes `change` into one VEVENT; every other property stays. */
  #apply(ev: ICAL.Component, change: ExternalChange, addresses: readonly string[]): void {
    const set = (name: string, value: string | null) => {
      ev.removeAllProperties(name);
      if (value) ev.addPropertyWithValue(name, value);
    };
    if (change.summary !== undefined) {
      ev.removeAllProperties("summary");
      ev.addPropertyWithValue("summary", change.summary);
    }
    if (change.description !== undefined) set("description", change.description);
    if (change.location !== undefined) set("location", change.location);
    if (change.busy !== undefined) set("transp", change.busy ? "OPAQUE" : "TRANSPARENT");
    if (change.visibility !== undefined)
      set("class", change.visibility === "default" ? null : change.visibility.toUpperCase());
    if (change.colorId !== undefined)
      set("color", change.colorId ? (COLOR_NAMES[change.colorId] ?? null) : null);
    if (change.reminders !== undefined) {
      for (const alarm of ev.getAllSubcomponents("valarm")) ev.removeSubcomponent(alarm);
      addAlarms(ev, change.reminders, String(ev.getFirstPropertyValue("summary") ?? ""));
    }
    const instant = (name: string) => {
      const v = ev.getFirstPropertyValue(name);
      return v instanceof ICAL.Time ? instantOf(v, this.#zone) : null;
    };
    const retimed =
      (change.start !== undefined && change.start !== instant("dtstart")) ||
      (change.end !== undefined && change.end !== instant("dtend"));
    if (change.end !== undefined) {
      ev.removeAllProperties("duration");
      ev.removeAllProperties("dtend");
      ev.addPropertyWithValue("dtend", toUtcTime(change.end));
    }
    if (change.start !== undefined) {
      ev.removeAllProperties("dtstart");
      ev.addPropertyWithValue("dtstart", toUtcTime(change.start));
    }
    const self = selfOf(addresses);
    if (change.guests) {
      const { add, remove } = change.guests;
      const gone = new Set(remove.map((e) => e.toLowerCase()));
      const role = new Map(add.map((g) => [g.email.toLowerCase(), g.optional]));
      for (const a of ev.getAllProperties("attendee")) {
        const email = mailto(a.getFirstValue());
        if (gone.has(email)) ev.removeProperty(a);
        else if (role.has(email)) {
          if (role.get(email)) a.setParameter("role", "OPT-PARTICIPANT");
          else a.removeParameter("role");
          role.delete(email);
        }
      }
      for (const [email, optional] of role) {
        const p = ev.addPropertyWithValue("attendee", `mailto:${email}`);
        if (optional) p.setParameter("role", "OPT-PARTICIPANT");
      }
    }
    // A new time asks the guests again (RFC 5546 3.2.2: a new SEQUENCE).
    if (retimed) {
      for (const a of ev.getAllProperties("attendee"))
        if (!self.all.has(mailto(a.getFirstValue()))) a.removeParameter("partstat");
      const sequence = Number(ev.getFirstPropertyValue("sequence") ?? 0);
      ev.removeAllProperties("sequence");
      ev.addPropertyWithValue("sequence", sequence + 1);
    }
    if (change.selfResponse) {
      const partstat = {
        needsAction: "NEEDS-ACTION",
        accepted: "ACCEPTED",
        declined: "DECLINED",
        tentative: "TENTATIVE",
      }[change.selfResponse];
      // One line only: a second address in the set may be a shared mailbox.
      selfLine(ev, self)?.setParameter("partstat", partstat);
      // The note goes with the answer, as an iCalendar COMMENT of the user's copy.
      if (change.comment !== undefined) set("comment", change.comment);
    }
    ev.removeAllProperties("last-modified");
    ev.addPropertyWithValue("last-modified", toUtcTime(this.#now()));
  }

  /**
   * The series object of an instance id (`<object url>#<recurrence id>`): the
   * parsed object, its master, the instance's original start and its override.
   */
  async #series(calendarId: string, eventId: string): Promise<Series> {
    const client = await this.#connect();
    const cal = await this.#calendar(calendarId);
    const hash = eventId.indexOf("#");
    const url = eventId.slice(0, hash);
    const rid = eventId.slice(hash + 1);
    const obj = await this.#object(cal, url);
    const root = new ICAL.Component(ICAL.parse(obj.data));
    for (const tz of root.getAllSubcomponents("vtimezone")) {
      ICAL.TimezoneService.register(new ICAL.Timezone(tz));
    }
    const vevents = root.getAllSubcomponents("vevent");
    const master = vevents.find((v) => !v.hasProperty("recurrence-id"));
    if (!master) throw new ProviderError("not_found", 404, "Event not found");
    // The instance's original start, as the series rule makes it.
    const bound = Date.parse(rid) + 2 * 86_400_000;
    const it = new ICAL.Event(master).iterator();
    let occurrence: ICAL.Time | null = null;
    for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
      if (next.toString() === rid) {
        occurrence = next;
        break;
      }
      if (Number.isFinite(bound) && next.toUnixTime() * 1000 > bound) break;
    }
    if (!occurrence) throw new ProviderError("not_found", 404, "Instance not found");
    const at = occurrence.toUnixTime();
    const override = vevents.find((v) => {
      const r = v.getFirstPropertyValue("recurrence-id");
      return v !== master && r instanceof ICAL.Time && r.toUnixTime() === at;
    });
    return { client, url, etag: obj.etag ?? null, root, master, occurrence, override };
  }

  async #putSeries(url: string, root: ICAL.Component, etag: string | null): Promise<string | null> {
    const client = await this.#connect();
    const res = await client.updateCalendarObject({
      calendarObject: { url, data: root.toString(), ...(etag ? { etag } : {}) },
    });
    if (res.status === 412) throw new ProviderError("precondition_failed", 412, "Event changed");
    if (res.status === 404) throw new ProviderError("not_found", 404, "Event not found");
    if (!res.ok) throw new ProviderError("other", res.status, `Update failed: ${res.status}`);
    return res.headers.get("etag");
  }

  /** The current start and end of an instance: its override's, or the series rule's. */
  #instanceTimes(
    { master, occurrence, override }: Series,
    fallbackLength = 0,
  ): { start: number; end: number } {
    const at = (name: string) => {
      const v = override?.getFirstPropertyValue(name);
      return v instanceof ICAL.Time ? instantOf(v, this.#zone) : null;
    };
    const length = (master.getFirstPropertyValue("dtend") as ICAL.Time | null)?.subtractDate(
      master.getFirstPropertyValue("dtstart") as ICAL.Time,
    );
    const start = at("dtstart") ?? instantOf(occurrence, this.#zone);
    const end = at("dtend") ?? start + (length ? length.toSeconds() * 1000 : fallbackLength);
    return { start, end };
  }

  /**
   * The override of an instance (RFC 5545 RECURRENCE-ID); a new one copies the
   * series' properties and the instance's time.
   */
  #override(series: Series): ICAL.Component {
    const { root, master, occurrence, override } = series;
    if (override) return override;
    const { start, end } = this.#instanceTimes(series);
    const ov = new ICAL.Component("vevent");
    const skip = new Set(["rrule", "rdate", "exdate", "exrule", "dtstart", "dtend", "duration"]);
    for (const p of master.getAllProperties()) {
      if (!skip.has(p.name)) ov.addProperty(new ICAL.Property(structuredClone(p.toJSON())));
    }
    for (const alarm of master.getAllSubcomponents("valarm"))
      ov.addSubcomponent(new ICAL.Component(structuredClone(alarm.toJSON())));
    const rid = new ICAL.Property("recurrence-id");
    rid.setValue(occurrence);
    const tzid = occurrence.zone?.tzid;
    if (tzid && tzid !== "UTC" && tzid !== "floating") rid.setParameter("tzid", tzid);
    ov.addProperty(rid);
    ov.addPropertyWithValue("dtstart", toUtcTime(start));
    ov.addPropertyWithValue("dtend", toUtcTime(end));
    root.addSubcomponent(ov);
    series.override = ov;
    return ov;
  }

  /** Changes one instance of a series: writes or replaces its override (RFC 5545 RECURRENCE-ID). */
  async #updateInstance(
    calendarId: string,
    eventId: string,
    w: EventWrite,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const series = await this.#series(calendarId, eventId);
    const { url, etag: current, root, master } = series;
    const { start: oldStart, end: oldEnd } = this.#instanceTimes(series, w.end - w.start);
    const ov = this.#override(series);
    // Guests keep their answers unless the time changes (a new time asks again).
    const keep = oldStart === w.start && oldEnd === w.end;
    const answers = new Map(
      ov
        .getAllProperties("attendee")
        .map((a) => [mailto(a.getFirstValue()), a.getParameter("partstat")]),
    );
    const props = { ...readProps(master), ...w.privateProps };
    for (const name of ["dtstart", "dtend", "duration", "summary", "description", "location"])
      ov.removeAllProperties(name);
    for (const name of ["transp", "color", "attendee", "last-modified", PROPS_PROPERTY])
      ov.removeAllProperties(name);
    ov.addPropertyWithValue("dtstart", toUtcTime(w.start));
    ov.addPropertyWithValue("dtend", toUtcTime(w.end));
    ov.addPropertyWithValue("summary", w.summary);
    if (w.description) ov.addPropertyWithValue("description", w.description);
    if (w.location) ov.addPropertyWithValue("location", w.location);
    ov.addPropertyWithValue("transp", w.busy ? "OPAQUE" : "TRANSPARENT");
    if (w.colorId && COLOR_NAMES[w.colorId])
      ov.addPropertyWithValue("color", COLOR_NAMES[w.colorId]);
    if (w.organizer) {
      ov.removeAllProperties("organizer");
      ov.addPropertyWithValue("organizer", `mailto:${w.organizer}`);
    }
    const guest = (email: string, optional: boolean) => {
      const p = ov.addPropertyWithValue("attendee", `mailto:${email}`);
      if (optional) p.setParameter("role", "OPT-PARTICIPANT");
      const answer = answers.get(email.toLowerCase());
      if (keep && typeof answer === "string") p.setParameter("partstat", answer);
    };
    for (const email of w.attendees ?? []) guest(email, false);
    for (const email of w.optionalAttendees ?? []) guest(email, true);
    const sequence = Number(ov.getFirstPropertyValue("sequence") ?? 0);
    ov.removeAllProperties("sequence");
    ov.addPropertyWithValue("sequence", keep ? sequence : sequence + 1);
    ov.addPropertyWithValue("last-modified", toUtcTime(this.#now()));
    ov.addPropertyWithValue(
      PROPS_PROPERTY,
      Buffer.from(JSON.stringify(props)).toString("base64url"),
    );
    const tag = await this.#putSeries(url, root, current ?? etag);
    const from = Math.min(oldStart, w.start) - 86_400_000;
    const to = Math.max(oldEnd, w.end) + 86_400_000;
    const found = eventsFromObject(
      root.toString(),
      url,
      tag,
      from,
      to,
      this.#zone,
      await this.#self(),
    ).find((e) => e.id === eventId);
    if (!found) throw new ProviderError("other", 500, "Instance missing after update");
    return found;
  }

  /** Cancels one instance of a series with an EXDATE; its override goes. */
  async #cancelInstance(calendarId: string, eventId: string): Promise<void> {
    const series = await this.#series(calendarId, eventId).catch((err: unknown) => {
      if (err instanceof ProviderError && err.kind === "not_found") return null;
      throw err;
    });
    if (!series) return;
    const { url, etag, root, master, occurrence, override } = series;
    if (override) root.removeSubcomponent(override);
    const ex = new ICAL.Property("exdate");
    ex.setValue(occurrence);
    const tzid = occurrence.zone?.tzid;
    if (tzid && tzid !== "UTC" && tzid !== "floating") ex.setParameter("tzid", tzid);
    master.addProperty(ex);
    await this.#putSeries(url, root, etag);
  }

  async setSeriesProps(
    calendarId: string,
    seriesId: string,
    props: Record<string, string>,
  ): Promise<void> {
    const cal = await this.#calendar(calendarId);
    const obj = await this.#object(cal, seriesId);
    const root = new ICAL.Component(ICAL.parse(obj.data));
    const value = Buffer.from(JSON.stringify(props)).toString("base64url");
    for (const ev of root.getAllSubcomponents("vevent")) {
      ev.removeAllProperties(PROPS_PROPERTY);
      if (Object.keys(props).length > 0) ev.addPropertyWithValue(PROPS_PROPERTY, value);
    }
    await this.#putSeries(seriesId, root, obj.etag ?? null);
  }

  /** The series object at `url`, parsed, with its master. */
  async #seriesObject(calendarId: string, url: string) {
    const client = await this.#connect();
    const cal = await this.#calendar(calendarId);
    const obj = await this.#object(cal, url);
    const root = new ICAL.Component(ICAL.parse(obj.data));
    for (const tz of root.getAllSubcomponents("vtimezone")) {
      ICAL.TimezoneService.register(new ICAL.Timezone(tz));
    }
    const master = root.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
    if (!master) throw new ProviderError("not_found", 404, "Event not found");
    return { client, root, master, etag: obj.etag ?? null, data: obj.data };
  }

  async seriesInstances(
    calendarId: string,
    seriesId: string,
    from: number,
    to: number,
  ): Promise<ProviderEvent[]> {
    const { data, etag } = await this.#seriesObject(calendarId, seriesId);
    return eventsFromObject(data, seriesId, etag, from, to, this.#zone, await this.#self()).filter(
      (e) => e.recurringId === seriesId,
    );
  }

  /** A time of the series' own kind: local in the master's TZID, else UTC. */
  #seriesTime(master: ICAL.Component, ms: number): { time: ICAL.Time; tzid: string | null } {
    const tzid = master.getFirstProperty("dtstart")?.getParameter("tzid");
    const zone = typeof tzid === "string" && isValidTimeZone(tzid) ? tzid : null;
    return { time: zone ? localTime(zone, ms) : toUtcTime(ms), tzid: zone };
  }

  async addInstance(calendarId: string, seriesId: string, w: EventWrite): Promise<ProviderEvent> {
    const { root, master, etag } = await this.#seriesObject(calendarId, seriesId);
    const { time, tzid } = this.#seriesTime(master, w.start);
    // At a rule time with an EXDATE: removing the EXDATE gives the instance
    // back. An RDATE there too would make two instances at the same time.
    let ruleTime = false;
    for (const p of master.getAllProperties("exdate"))
      if ((p.getFirstValue() as ICAL.Time | null)?.toString() === time.toString()) {
        master.removeProperty(p);
        ruleTime = true;
      }
    if (!ruleTime) {
      const rdate = new ICAL.Property("rdate");
      rdate.setValue(time);
      if (tzid) rdate.setParameter("tzid", tzid);
      master.addProperty(rdate);
    }
    const tag = await this.#putSeries(seriesId, root, etag);
    return this.#updateInstance(calendarId, `${seriesId}#${time.toString()}`, w, tag);
  }

  async endSeries(calendarId: string, seriesId: string, at: number, keep: string[]): Promise<void> {
    const found = await this.#seriesObject(calendarId, seriesId).catch((err: unknown) => {
      if (err instanceof ProviderError && err.kind === "not_found") return null;
      throw err;
    });
    if (!found) return;
    const { client, root, master, etag } = found;
    const kept = new Set(keep);
    const idOf = (t: ICAL.Time) => `${seriesId}#${t.toString()}`;
    const instant = (t: unknown) =>
      t instanceof ICAL.Time ? instantOf(t, this.#zone) : Number.NEGATIVE_INFINITY;
    const tzid = master.getFirstProperty("dtstart")?.getParameter("tzid");
    const start = master.getFirstPropertyValue("dtstart");
    const datesOf = (name: string) =>
      new Set(
        master.getAllProperties(name).map((p) => (p.getFirstValue() as ICAL.Time).toString()),
      );
    const rdates = datesOf("rdate");
    const exdates = datesOf("exdate");
    const add = (name: "rdate" | "exdate", t: ICAL.Time) => {
      const set = name === "rdate" ? rdates : exdates;
      if (set.has(t.toString())) return;
      const p = new ICAL.Property(name);
      p.setValue(t);
      if (typeof tzid === "string" && !t.zone?.tzid?.startsWith("UTC"))
        p.setParameter("tzid", tzid);
      master.addProperty(p);
      set.add(t.toString());
    };
    // An instance counts by its start: an override's own start, else its rule
    // time (the RECURRENCE-ID). The rule ends at `at`, so an instance kept
    // with a later rule time needs an RDATE of that time (its id); a removed
    // one whose rule time is before `at` needs an EXDATE.
    const keepRdate = new Set<string>();
    for (const ov of root.getAllSubcomponents("vevent")) {
      if (ov === master) continue;
      const rid = ov.getFirstPropertyValue("recurrence-id");
      if (!(rid instanceof ICAL.Time)) continue;
      const ruleLater = instant(rid) >= at;
      const startLater = instant(ov.getFirstPropertyValue("dtstart") ?? rid) >= at;
      if (startLater && !kept.has(idOf(rid))) {
        root.removeSubcomponent(ov);
        if (!ruleLater) add("exdate", rid);
        continue;
      }
      if (ruleLater) keepRdate.add(rid.toString());
    }
    // Kept instances without an override stay at their rule time.
    for (const id of kept) {
      if (!id.startsWith(`${seriesId}#`) || !(start instanceof ICAL.Time)) continue;
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(
        id.slice(seriesId.length + 1),
      );
      if (!m) continue;
      const t = start.clone();
      [t.year, t.month, t.day, t.hour, t.minute, t.second] = m.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      if (instant(t) >= at) keepRdate.add(t.toString());
    }
    for (const p of master.getAllProperties("rdate")) {
      const t = p.getFirstValue() as ICAL.Time;
      if (instant(t) >= at && !keepRdate.has(t.toString())) {
        master.removeProperty(p);
        rdates.delete(t.toString());
      }
    }
    for (const ov of root.getAllSubcomponents("vevent")) {
      const rid = ov.getFirstPropertyValue("recurrence-id");
      if (ov !== master && rid instanceof ICAL.Time && keepRdate.has(rid.toString()))
        add("rdate", rid);
    }
    for (const id of keepRdate) {
      const ov = root
        .getAllSubcomponents("vevent")
        .some(
          (v) => (v.getFirstPropertyValue("recurrence-id") as ICAL.Time | null)?.toString() === id,
        );
      if (ov || !(start instanceof ICAL.Time)) continue;
      const t = start.clone();
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(id);
      if (!m) continue;
      [t.year, t.month, t.day, t.hour, t.minute, t.second] = m.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      add("rdate", t);
    }
    // Tempoloom ended this series: it is never read as the organizer's split.
    for (const ev of root.getAllSubcomponents("vevent")) {
      const props = { ...readProps(ev), tl_ended: "1" };
      ev.removeAllProperties(PROPS_PROPERTY);
      ev.addPropertyWithValue(
        PROPS_PROPERTY,
        Buffer.from(JSON.stringify(props)).toString("base64url"),
      );
    }
    const rule = master.getFirstPropertyValue("rrule");
    if (instant(start) >= at) {
      // The series had not started: only the kept instances stay, as RDATEs.
      // The rule keeps DTSTART only (COUNT=1), so the object stays a series and
      // an override of the first instance still applies.
      if (rule instanceof ICAL.Recur) {
        rule.until = null as unknown as ICAL.Time;
        rule.count = 1;
        master.removeAllProperties("rrule");
        master.addPropertyWithValue("rrule", rule);
      }
      // A first instance that moved earlier and started is kept by its start:
      // DTSTART itself is that instance, so no RDATE (and no EXDATE) there.
      const startedFirst = start instanceof ICAL.Time && keepRdate.has(start.toString());
      if (startedFirst)
        for (const p of master.getAllProperties("rdate"))
          if ((p.getFirstValue() as ICAL.Time).toString() === start.toString()) {
            master.removeProperty(p);
            rdates.delete(start.toString());
          }
      const startKept = startedFirst || (start instanceof ICAL.Time && kept.has(idOf(start)));
      if (!startKept && rdates.size === 0) {
        const res = await client.deleteCalendarObject({ calendarObject: { url: seriesId } });
        if (!res.ok && res.status !== 404 && res.status !== 410)
          throw new ProviderError("other", res.status, `Delete failed: ${res.status}`);
        return;
      }
      if (!startKept && start instanceof ICAL.Time) add("exdate", start);
    } else if (rule instanceof ICAL.Recur) {
      rule.count = null as unknown as number;
      rule.until = toUtcTime(at - 1000);
      master.removeAllProperties("rrule");
      master.addPropertyWithValue("rrule", rule);
    }
    await this.#putSeries(seriesId, root, etag);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    if (eventId.includes("#")) return this.#cancelInstance(calendarId, eventId);
    const client = await this.#connect();
    await this.#calendar(calendarId);
    const res = await client.deleteCalendarObject({ calendarObject: { url: eventId } });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new ProviderError("other", res.status, `Delete failed: ${res.status}`);
    }
  }
}
