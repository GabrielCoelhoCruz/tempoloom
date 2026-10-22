import { localToUtc, utcToLocal } from "../../shared/time.ts";
import {
  GoogleApiError,
  type GoogleCalendarApi,
  type GoogleEvent,
  type GoogleEventInput,
  type GoogleEventTime,
  SyncTokenExpiredError,
} from "../google/calendar.ts";
import { OAuthError } from "../google/oauth.ts";
import {
  type CalendarProvider,
  type EventChanges,
  type EventWrite,
  type ExternalChange,
  type ProfileSettings,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
  type ResponseStatus,
} from "./types.ts";

const DAY_MS = 86_400_000;

function toInstant(t: GoogleEventTime | undefined, zone: string): { ms: number; allDay: boolean } {
  if (t?.dateTime) return { ms: Date.parse(t.dateTime), allDay: false };
  if (t?.date) return { ms: localToUtc(t.timeZone ?? zone, t.date, 0), allDay: true };
  return { ms: 0, allDay: false };
}

export function fromGoogleEvent(e: GoogleEvent, zone: string): ProviderEvent {
  const start = toInstant(e.start, zone);
  const end = toInstant(e.end, zone);
  const self = e.attendees?.find((a) => a.self);
  return {
    id: e.id,
    cancelled: e.status === "cancelled" || !e.start || !e.end,
    etag: e.etag ?? null,
    summary: e.summary ?? "",
    description: e.description ?? "",
    location: e.location ?? "",
    start: start.ms,
    end: end.ms,
    allDay: start.allDay,
    busy: e.transparency !== "transparent",
    eventType: e.eventType ?? "default",
    selfResponse: self?.responseStatus ?? null,
    rsvpNote: self?.comment ?? "",
    attendeeCount: e.attendees?.filter((a) => !a.resource).length ?? 0,
    attendees: (e.attendees ?? [])
      .filter((a) => !a.resource && a.email)
      .map((a) => (a.email ?? "").toLowerCase()),
    // Google sends `self` only when it is true (SCH-21: an unanswered invitation blocks nothing).
    organizerSelf: e.organizer?.self === true,
    organizerEmail: (e.organizer?.email ?? "").toLowerCase(),
    recurringId: e.recurringEventId ?? null,
    colorId: e.colorId ?? null,
    updated: e.updated ? Date.parse(e.updated) : null,
    privateProps: e.extendedProperties?.private ?? {},
    responses: Object.fromEntries(
      (e.attendees ?? [])
        .filter((a) => !a.resource && a.email && a.responseStatus)
        .map((a) => [(a.email ?? "").toLowerCase(), a.responseStatus as ResponseStatus]),
    ),
    conference: e.hangoutLink ?? "",
    alerts: e.reminders?.useDefault === true || (e.reminders?.overrides?.length ?? 0) > 0,
    visibility: e.visibility ?? "default",
  };
}

/**
 * Calendars that Google makes, such as national holidays and birthdays, are
 * not offered (accounts-connected-calendars.md rules 4, 5).
 */
export const providerMade = (id: string) => id.endsWith("@group.v.calendar.google.com");

function toGoogleReminders(r: EventWrite["reminders"]): NonNullable<GoogleEventInput["reminders"]> {
  return !r
    ? { useDefault: false }
    : "useDefault" in r
      ? { useDefault: true }
      : {
          useDefault: false,
          overrides: r.minutes.map((minutes) => ({ method: "popup", minutes })),
        };
}

/** A local date-time of `zone` in iCalendar basic form, for EXDATE lines. */
const icalLocal = (zone: string, ms: number) => {
  const l = utcToLocal(zone, ms);
  const hh = String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0");
  const mm = String(l.minuteOfDay % 60).padStart(2, "0");
  return `${l.date.replace(/-/g, "")}T${hh}${mm}00`;
};

function toGoogleEvent(w: EventWrite): GoogleEventInput {
  // A series keeps its local time across DST: Google needs the zone of a recurring event.
  const zone = w.recurrence && w.timeZone ? { timeZone: w.timeZone } : {};
  return {
    summary: w.summary,
    description: w.description,
    start: w.allDayDates
      ? { date: w.allDayDates.start }
      : { dateTime: new Date(w.start).toISOString(), ...zone },
    end: w.allDayDates
      ? { date: w.allDayDates.end }
      : { dateTime: new Date(w.end).toISOString(), ...zone },
    transparency: w.busy ? "opaque" : "transparent",
    ...(w.colorId ? { colorId: w.colorId } : {}),
    ...(w.location ? { location: w.location } : {}),
    ...(w.attendees || w.optionalAttendees
      ? {
          attendees: [
            ...(w.attendees ?? []).map((email) => ({ email })),
            ...(w.optionalAttendees ?? []).map((email) => ({ email, optional: true })),
          ],
        }
      : {}),
    reminders: toGoogleReminders(w.reminders),
    ...(w.visibility ? { visibility: w.visibility } : {}),
    extendedProperties: { private: w.privateProps },
    ...(w.recurrence
      ? {
          recurrence: [
            `RRULE:${w.recurrence}`,
            ...(w.exdates ?? []).map((t) =>
              w.timeZone
                ? `EXDATE;TZID=${w.timeZone}:${icalLocal(w.timeZone, t)}`
                : `EXDATE:${new Date(t).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
            ),
          ],
        }
      : {}),
  };
}

function mapError(err: unknown): never {
  if (err instanceof SyncTokenExpiredError) {
    throw new ProviderError("sync_token_expired", 410, err.message);
  }
  if (err instanceof GoogleApiError) {
    const kind =
      err.status === 412
        ? "precondition_failed"
        : err.status === 404 || err.status === 410
          ? "not_found"
          : err.status === 401
            ? "auth"
            : "other";
    throw new ProviderError(kind, err.status, err.message);
  }
  // A revoked refresh token or an account that needs a new login is a
  // rejected login of this account only (accounts-login-emails-permissions.md rule 16).
  if (err instanceof OAuthError && (err.code === "invalid_grant" || err.code === "reauth_required"))
    throw new ProviderError("auth", 401, err.message);
  throw err;
}

export class GoogleProvider implements CalendarProvider {
  readonly #api: GoogleCalendarApi;
  readonly #zone: string;

  constructor(api: GoogleCalendarApi, zone: string) {
    this.#api = api;
    this.#zone = zone;
  }

  async listCalendars(): Promise<ProviderCalendar[]> {
    const list = await this.#api.listCalendars().catch(mapError);
    return list
      .filter((c) => !providerMade(c.id))
      .map((c) => ({
        id: c.id,
        name: c.summary,
        primary: c.primary === true,
        writable: c.accessRole === "owner" || c.accessRole === "writer",
        timeZone: c.timeZone ?? null,
        color: c.backgroundColor ?? null,
      }));
  }

  async profileSettings(): Promise<ProfileSettings> {
    const s = await this.#api.settings().catch(mapError);
    const week = s.get("weekStart");
    const h24 = s.get("format24HourTime");
    const order = s.get("dateFieldOrder");
    return {
      // Google also allows Saturday ("6"); Tempoloom has Monday and Sunday only.
      ...(week === "1" ? { weekStart: 1 as const } : week === "0" ? { weekStart: 7 as const } : {}),
      ...(h24 === "true"
        ? { timeFormat: "24h" as const }
        : h24 === "false"
          ? { timeFormat: "12h" as const }
          : {}),
      ...(order === "YMD" || order === "DMY" || order === "MDY" ? { dateFormat: order } : {}),
    };
  }

  async freeBusy(
    emails: string[],
    timeMin: number,
    timeMax: number,
  ): Promise<Map<string, { start: number; end: number }[]>> {
    if (emails.length === 0) return new Map();
    const found = await this.#api.freeBusy(emails, timeMin, timeMax).catch(mapError);
    return new Map([...found].map(([id, busy]) => [id.toLowerCase(), busy]));
  }

  async listEvents(
    calendarId: string,
    opts: { syncToken: string | null; timeMin: number; timeMax: number },
  ): Promise<EventChanges> {
    const page = await this.#api
      .listEvents(
        calendarId,
        opts.syncToken
          ? { syncToken: opts.syncToken }
          : { timeMin: opts.timeMin, timeMax: opts.timeMax },
      )
      .catch(mapError);
    return {
      events: page.events.map((e) => fromGoogleEvent(e, this.#zone)),
      nextSyncToken: page.nextSyncToken,
      full: !opts.syncToken,
    };
  }

  async insertEvent(calendarId: string, event: EventWrite): Promise<ProviderEvent> {
    const ev = await this.#api.insertEvent(calendarId, toGoogleEvent(event)).catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: EventWrite,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const ev = await this.#api
      .patchEvent(calendarId, eventId, toGoogleEvent(event), etag ? { etag } : {})
      .catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  async setColor(
    calendarId: string,
    eventId: string,
    colorId: string | null,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const ev = await this.#api
      .patchEvent(calendarId, eventId, { colorId: colorId ?? "" }, etag ? { etag } : {})
      .catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  /** editExternal sends no update to guests (sendUpdates "none"), except with an answer. */
  async notifiesGuests(): Promise<boolean> {
    return false;
  }

  async editExternal(
    calendarId: string,
    eventId: string,
    change: ExternalChange,
    etag: string | null,
  ): Promise<ProviderEvent> {
    const patch: Partial<GoogleEventInput> = {};
    if (change.summary !== undefined) patch.summary = change.summary;
    if (change.description !== undefined) patch.description = change.description;
    if (change.location !== undefined) patch.location = change.location;
    if (change.busy !== undefined) patch.transparency = change.busy ? "opaque" : "transparent";
    if (change.visibility !== undefined) patch.visibility = change.visibility;
    if (change.colorId !== undefined) patch.colorId = change.colorId ?? "";
    if (change.reminders !== undefined) patch.reminders = toGoogleReminders(change.reminders);
    if (change.end !== undefined) patch.end = { dateTime: new Date(change.end).toISOString() };
    if (change.start !== undefined)
      patch.start = { dateTime: new Date(change.start).toISOString() };
    const answer = change.selfResponse;
    const retimed = change.start !== undefined || change.end !== undefined;
    if (answer || change.guests || retimed) {
      const current = await this.#api.getEvent(calendarId, eventId).catch(mapError);
      const moved =
        retimed &&
        ((change.start !== undefined &&
          Date.parse(current.start?.dateTime ?? "") !== change.start) ||
          (change.end !== undefined && Date.parse(current.end?.dateTime ?? "") !== change.end));
      if (answer || change.guests || (moved && current.attendees?.length)) {
        const gone = new Set(change.guests?.remove.map((e) => e.toLowerCase()));
        const role = new Map(change.guests?.add.map((g) => [g.email.toLowerCase(), g.optional]));
        const list = (current.attendees ?? [])
          .filter((a) => !gone.has(a.email.toLowerCase()))
          .map((a) => {
            const email = a.email.toLowerCase();
            const optional = role.get(email);
            role.delete(email);
            return {
              ...a,
              ...(optional !== undefined ? { optional } : {}),
              // A new time asks the guests again.
              ...(moved && !a.self ? { responseStatus: "needsAction" as const } : {}),
              ...(a.self && answer
                ? {
                    responseStatus: answer,
                    ...(change.comment !== undefined ? { comment: change.comment } : {}),
                  }
                : {}),
            };
          });
        for (const [email, optional] of role) list.push({ email, optional });
        patch.attendees = list;
      }
    }
    // The organizer hears about a changed answer; nobody hears about other edits.
    const ev = await this.#api
      .patchEvent(calendarId, eventId, patch, {
        ...(etag && !change.selfResponse ? { etag } : {}),
        sendUpdates: change.selfResponse ? "all" : "none",
      })
      .catch(mapError);
    return fromGoogleEvent(ev, this.#zone);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.#api.deleteEvent(calendarId, eventId).catch(mapError);
  }

  async setSeriesProps(
    calendarId: string,
    seriesId: string,
    props: Record<string, string>,
  ): Promise<void> {
    await this.#api
      .patchEvent(calendarId, seriesId, { extendedProperties: { private: props } })
      .catch(mapError);
  }

  async seriesInstances(
    calendarId: string,
    seriesId: string,
    from: number,
    to: number,
  ): Promise<ProviderEvent[]> {
    const list = await this.#api.instances(calendarId, seriesId, from, to).catch(mapError);
    return list.map((e) => fromGoogleEvent(e, this.#zone)).filter((e) => !e.cancelled);
  }

  /**
   * Ends a series before `at`: an UNTIL in its RRULE. Google keeps no instance
   * of a series after its end, so `keep` stays unused here.
   */
  async endSeries(calendarId: string, seriesId: string, at: number): Promise<void> {
    const master = await this.#api.getEvent(calendarId, seriesId).catch((err: unknown) => {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return null;
      return mapError(err);
    });
    if (!master?.recurrence) return;
    const first = toInstant(master.start, this.#zone).ms;
    // Instances that started before `at` stay, also one that moved earlier
    // than the series' first rule time; the rule ends after the last of them.
    let end = at;
    if (first >= at) {
      const held = (
        await this.#api.instances(calendarId, seriesId, first - 366 * DAY_MS, at).catch(mapError)
      )
        .filter((e) => e.status !== "cancelled" && toInstant(e.start, this.#zone).ms < at)
        .map((e) => toInstant(e.originalStartTime ?? e.start, this.#zone).ms);
      if (held.length === 0) {
        await this.#api.deleteEvent(calendarId, seriesId).catch(mapError);
        return;
      }
      end = Math.max(...held) + 1000;
      for (const e of await this.#api.instances(calendarId, seriesId, at, end).catch(mapError))
        if (toInstant(e.start, this.#zone).ms >= at && e.status !== "cancelled")
          await this.#api.deleteEvent(calendarId, e.id).catch(mapError);
    }
    const until = new Date(end - 1000).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const recurrence = master.recurrence.map((r) =>
      r.startsWith("RRULE:")
        ? `RRULE:${[
            ...r
              .slice(6)
              .split(";")
              .filter((p) => !/^(UNTIL|COUNT)=/.test(p)),
            `UNTIL=${until}`,
          ].join(";")}`
        : r,
    );
    await this.#api.patchEvent(calendarId, seriesId, { recurrence }).catch(mapError);
  }
}
